import { createPool, type VercelPool, type VercelPoolClient } from '@vercel/postgres';
import type { Address, Bytes32 } from 'bam-sdk';

import type {
  BamStore,
  BatchRow,
  MessageRow,
  NonceTrackerRow,
  PendingKey,
  ReaderCursorRow,
  StoreTxn,
  StoreTxnPendingRow,
  StoreTxnSubmittedRow,
  SubmittedBatchStatus,
  SubmittedBatchesQuery,
} from './types.js';
import { decodeNonce, encodeNonce } from './nonce-codec.js';
import { SCHEMA_VERSION, SQL_CREATE_POSTGRES } from './schema.js';
import { decodeSnapshots, encodeSnapshots } from './snapshot-codec.js';

function isSerializationFailure(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === '40001'
  );
}

interface PendingRowRaw {
  content_tag: string;
  sender: string;
  nonce: string;
  contents: Buffer;
  signature: Buffer;
  message_hash: string;
  ingested_at: string | number;
  ingest_seq: string | number;
}

interface SubmittedRowRaw {
  tx_hash: string;
  content_tag: string;
  blob_versioned_hash: string;
  batch_content_hash: string;
  block_number: string | number | null;
  status: string;
  replaced_by_tx_hash: string | null;
  submitted_at: string | number;
  invalidated_at: string | number | null;
  messages_json: string;
}

interface NonceRowRaw {
  sender: string;
  last_nonce: string;
  last_message_hash: string;
}

function toInt(value: string | number): number {
  return typeof value === 'number' ? value : Number(value);
}

function mapPending(raw: PendingRowRaw): StoreTxnPendingRow {
  return {
    contentTag: raw.content_tag as Bytes32,
    sender: raw.sender as Address,
    nonce: decodeNonce(raw.nonce),
    contents: new Uint8Array(raw.contents),
    signature: new Uint8Array(raw.signature),
    messageHash: raw.message_hash as Bytes32,
    ingestedAt: toInt(raw.ingested_at),
    ingestSeq: toInt(raw.ingest_seq),
  };
}

function mapSubmitted(raw: SubmittedRowRaw): StoreTxnSubmittedRow {
  return {
    txHash: raw.tx_hash as Bytes32,
    contentTag: raw.content_tag as Bytes32,
    blobVersionedHash: raw.blob_versioned_hash as Bytes32,
    batchContentHash: raw.batch_content_hash as Bytes32,
    blockNumber: raw.block_number === null ? null : toInt(raw.block_number),
    status: raw.status as SubmittedBatchStatus,
    replacedByTxHash: (raw.replaced_by_tx_hash ?? null) as Bytes32 | null,
    submittedAt: toInt(raw.submitted_at),
    invalidatedAt: raw.invalidated_at === null || raw.invalidated_at === undefined ? null : toInt(raw.invalidated_at),
    messages: decodeSnapshots(raw.messages_json),
  };
}

export class PostgresBamStore implements BamStore {
  private readonly pool: VercelPool;
  private ready: Promise<void>;

  constructor(connectionString: string) {
    this.pool = createPool({ connectionString });
    this.ready = this.initSchema();
  }

  private async initSchema(): Promise<void> {
    const client = await this.pool.connect();
    try {
      for (const stmt of SQL_CREATE_POSTGRES) {
        await client.query(stmt);
      }
      // Tag fresh DBs with the current schema version; leave existing
      // rows alone for the startup reconciliation guard.
      const existing = await client.query<{ version: number }>(
        'SELECT version FROM poster_schema LIMIT 1'
      );
      if (existing.rowCount === 0) {
        await client.query('INSERT INTO poster_schema (version) VALUES ($1)', [SCHEMA_VERSION]);
      }
    } finally {
      client.release();
    }
  }

  /** Returns the persisted schema version — used by `startup/reconcile.ts`. */
  async readSchemaVersion(): Promise<number> {
    await this.ready;
    const client = await this.pool.connect();
    try {
      const res = await client.query<{ version: number }>(
        'SELECT version FROM poster_schema LIMIT 1'
      );
      return res.rows[0]?.version ?? SCHEMA_VERSION;
    } finally {
      client.release();
    }
  }

  async withTxn<T>(fn: (txn: StoreTxn) => Promise<T>): Promise<T> {
    await this.ready;
    const MAX_RETRIES = 5;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        try {
          const txn = makePgTxn(client);
          const result = await fn(txn);
          await client.query('COMMIT');
          return result;
        } catch (err) {
          try {
            await client.query('ROLLBACK');
          } catch {
            // ignore
          }
          if (!isSerializationFailure(err) || attempt === MAX_RETRIES) {
            throw err;
          }
          lastErr = err;
        }
      } finally {
        client.release();
      }
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    }
    throw lastErr ?? new Error('withTxn: exhausted serialization retries');
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function makePgTxn(client: VercelPoolClient): StoreTxn {
  return {
    async insertPending(row: StoreTxnPendingRow): Promise<void> {
      await client.query(
        `INSERT INTO poster_pending
          (content_tag, sender, nonce, contents, signature, message_hash, ingested_at, ingest_seq)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          row.contentTag,
          row.sender.toLowerCase(),
          encodeNonce(row.nonce),
          Buffer.from(row.contents),
          Buffer.from(row.signature),
          row.messageHash,
          row.ingestedAt,
          row.ingestSeq,
        ]
      );
    },
    async getPendingByKey(key: PendingKey): Promise<StoreTxnPendingRow | null> {
      const res = await client.query<PendingRowRaw>(
        'SELECT * FROM poster_pending WHERE sender = $1 AND nonce = $2',
        [key.sender.toLowerCase(), encodeNonce(key.nonce)]
      );
      return res.rows[0] ? mapPending(res.rows[0]) : null;
    },
    async listPendingByTag(
      tag: Bytes32,
      limit?: number,
      sinceSeq?: number
    ): Promise<StoreTxnPendingRow[]> {
      const clauses = ['content_tag = $1'];
      const params: Array<string | number> = [tag];
      if (sinceSeq !== undefined) {
        clauses.push(`ingest_seq > $${params.length + 1}`);
        params.push(sinceSeq);
      }
      let sql = `SELECT * FROM poster_pending WHERE ${clauses.join(' AND ')} ORDER BY ingest_seq ASC`;
      if (typeof limit === 'number') {
        sql += ` LIMIT $${params.length + 1}`;
        params.push(limit);
      }
      const res = await client.query<PendingRowRaw>(sql, params);
      return res.rows.map(mapPending);
    },
    async listPendingAll(limit?: number, sinceSeq?: number): Promise<StoreTxnPendingRow[]> {
      const params: Array<string | number> = [];
      let sql = 'SELECT * FROM poster_pending';
      if (sinceSeq !== undefined) {
        sql += ` WHERE ingest_seq > $${params.length + 1}`;
        params.push(sinceSeq);
      }
      sql += ' ORDER BY ingested_at ASC, ingest_seq ASC';
      if (typeof limit === 'number') {
        sql += ` LIMIT $${params.length + 1}`;
        params.push(limit);
      }
      const res = await client.query<PendingRowRaw>(sql, params);
      return res.rows.map(mapPending);
    },
    async deletePending(keys: PendingKey[]): Promise<void> {
      if (keys.length === 0) return;
      // Build a VALUES list with lowercased senders + encoded nonces.
      const valueRows: string[] = [];
      const params: string[] = [];
      keys.forEach((k, i) => {
        valueRows.push(`($${i * 2 + 1}, $${i * 2 + 2})`);
        params.push(k.sender.toLowerCase(), encodeNonce(k.nonce));
      });
      await client.query(
        `DELETE FROM poster_pending WHERE (sender, nonce) IN (VALUES ${valueRows.join(', ')})`,
        params
      );
    },
    async countPendingByTag(tag: Bytes32): Promise<number> {
      const res = await client.query<{ c: string }>(
        'SELECT COUNT(*)::text AS c FROM poster_pending WHERE content_tag = $1',
        [tag]
      );
      return Number(res.rows[0]?.c ?? 0);
    },
    async nextIngestSeq(tag: Bytes32): Promise<number> {
      const res = await client.query<{ last_seq: string | number }>(
        `INSERT INTO poster_tag_seq (content_tag, last_seq) VALUES ($1, 1)
         ON CONFLICT (content_tag) DO UPDATE SET last_seq = poster_tag_seq.last_seq + 1
         RETURNING last_seq`,
        [tag]
      );
      const row = res.rows[0];
      if (!row) throw new Error('nextIngestSeq: INSERT ... RETURNING produced no row');
      return Number(row.last_seq);
    },

    async getNonce(sender: Address): Promise<NonceTrackerRow | null> {
      const res = await client.query<NonceRowRaw>(
        'SELECT * FROM poster_nonces WHERE sender = $1',
        [sender.toLowerCase()]
      );
      const raw = res.rows[0];
      if (!raw) return null;
      return {
        sender: raw.sender as Address,
        lastNonce: decodeNonce(raw.last_nonce),
        lastMessageHash: raw.last_message_hash as Bytes32,
      };
    },
    async setNonce(row: NonceTrackerRow): Promise<void> {
      await client.query(
        `INSERT INTO poster_nonces (sender, last_nonce, last_message_hash)
         VALUES ($1, $2, $3)
         ON CONFLICT (sender) DO UPDATE SET
           last_nonce = EXCLUDED.last_nonce,
           last_message_hash = EXCLUDED.last_message_hash`,
        [row.sender.toLowerCase(), encodeNonce(row.lastNonce), row.lastMessageHash]
      );
    },

    async insertSubmitted(row: StoreTxnSubmittedRow): Promise<void> {
      await client.query(
        `INSERT INTO poster_submitted_batches
          (tx_hash, content_tag, blob_versioned_hash, batch_content_hash,
           block_number, status, replaced_by_tx_hash, submitted_at,
           invalidated_at, messages_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          row.txHash,
          row.contentTag,
          row.blobVersionedHash,
          row.batchContentHash,
          row.blockNumber,
          row.status,
          row.replacedByTxHash,
          row.submittedAt,
          row.invalidatedAt,
          encodeSnapshots(row.messages),
        ]
      );
    },
    async getSubmittedByTx(txHash: Bytes32): Promise<StoreTxnSubmittedRow | null> {
      const res = await client.query<SubmittedRowRaw>(
        'SELECT * FROM poster_submitted_batches WHERE tx_hash = $1',
        [txHash]
      );
      return res.rows[0] ? mapSubmitted(res.rows[0]) : null;
    },
    async listSubmitted(query: SubmittedBatchesQuery): Promise<StoreTxnSubmittedRow[]> {
      const clauses: string[] = [];
      const params: Array<string | number> = [];
      if (query.contentTag !== undefined) {
        clauses.push(`content_tag = $${params.length + 1}`);
        params.push(query.contentTag);
      }
      if (query.sinceBlock !== undefined) {
        clauses.push(`block_number IS NOT NULL AND block_number >= $${params.length + 1}`);
        params.push(Number(query.sinceBlock));
      }
      let sql = 'SELECT * FROM poster_submitted_batches';
      if (clauses.length) sql += ' WHERE ' + clauses.join(' AND ');
      sql += ' ORDER BY submitted_at DESC';
      if (typeof query.limit === 'number') {
        sql += ` LIMIT $${params.length + 1}`;
        params.push(query.limit);
      }
      const res = await client.query<SubmittedRowRaw>(sql, params);
      return res.rows.map(mapSubmitted);
    },
    async updateSubmittedStatus(
      txHash: Bytes32,
      status: SubmittedBatchStatus,
      replacedByTxHash: Bytes32 | null,
      blockNumber: number | null,
      invalidatedAt?: number | null
    ): Promise<void> {
      const sets: string[] = ['status = $1', 'replaced_by_tx_hash = $2'];
      const params: Array<string | number | null> = [status, replacedByTxHash];
      if (blockNumber !== null) {
        sets.push(`block_number = $${params.length + 1}`);
        params.push(blockNumber);
      }
      if (invalidatedAt !== undefined) {
        sets.push(`invalidated_at = $${params.length + 1}`);
        params.push(invalidatedAt);
      }
      params.push(txHash);
      await client.query(
        `UPDATE poster_submitted_batches SET ${sets.join(', ')} WHERE tx_hash = $${params.length}`,
        params
      );
    },

    // ── unified-schema methods: stubbed until T007 ────────────────────
    async markSubmitted(): Promise<void> {
      throw new Error('markSubmitted not implemented (T007)');
    },
    async upsertObserved(): Promise<void> {
      throw new Error('upsertObserved not implemented (T007)');
    },
    async markDuplicate(): Promise<void> {
      throw new Error('markDuplicate not implemented (T007)');
    },
    async markReorged(): Promise<void> {
      throw new Error('markReorged not implemented (T007)');
    },
    async listMessages(): Promise<MessageRow[]> {
      throw new Error('listMessages not implemented (T007)');
    },
    async getByMessageId(): Promise<MessageRow | null> {
      throw new Error('getByMessageId not implemented (T007)');
    },
    async getByAuthorNonce(): Promise<MessageRow | null> {
      throw new Error('getByAuthorNonce not implemented (T007)');
    },
    async upsertBatch(): Promise<void> {
      throw new Error('upsertBatch not implemented (T007)');
    },
    async updateBatchStatus(): Promise<void> {
      throw new Error('updateBatchStatus not implemented (T007)');
    },
    async listBatches(): Promise<BatchRow[]> {
      throw new Error('listBatches not implemented (T007)');
    },
    async getCursor(): Promise<ReaderCursorRow | null> {
      throw new Error('getCursor not implemented (T007)');
    },
    async setCursor(): Promise<void> {
      throw new Error('setCursor not implemented (T007)');
    },
  };
}
