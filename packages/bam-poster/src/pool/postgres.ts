import { createPool, type VercelPool, type VercelPoolClient } from '@vercel/postgres';
import type { Address, Bytes32 } from 'bam-sdk';

import type {
  NonceTrackerRow,
  PosterStore,
  StoreTxn,
  StoreTxnPendingRow,
  StoreTxnSubmittedRow,
  SubmittedBatchStatus,
  SubmittedBatchesQuery,
} from '../types.js';
import { decodeNonce, encodeNonce } from './nonce-codec.js';
import { SQL_CREATE_POSTGRES } from './schema.js';
import { decodeSnapshots, encodeSnapshots } from './snapshot-codec.js';

/**
 * PostgreSQL signals a SERIALIZABLE conflict via SQLSTATE 40001
 * (serialization_failure). `@vercel/postgres` surfaces it on the
 * thrown error's `code` field. Retry is the documented remedy.
 */
function isSerializationFailure(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === '40001'
  );
}

interface PendingRowRaw {
  message_id: string;
  content_tag: string;
  author: string;
  nonce: string;
  timestamp: string | number;
  content: Buffer;
  signature: Buffer;
  ingested_at: string | number;
  ingest_seq: string | number;
}

interface SubmittedRowRaw {
  tx_hash: string;
  content_tag: string;
  blob_versioned_hash: string;
  block_number: string | number | null;
  status: string;
  replaced_by_tx_hash: string | null;
  submitted_at: string | number;
  message_ids_json: string;
  messages_json: string;
}

interface NonceRowRaw {
  author: string;
  last_nonce: string;
  last_message_id: string;
}

function toInt(value: string | number): number {
  return typeof value === 'number' ? value : Number(value);
}

function mapPending(raw: PendingRowRaw): StoreTxnPendingRow {
  return {
    messageId: raw.message_id as Bytes32,
    contentTag: raw.content_tag as Bytes32,
    author: raw.author as Address,
    nonce: decodeNonce(raw.nonce),
    timestamp: toInt(raw.timestamp),
    content: new Uint8Array(raw.content),
    signature: new Uint8Array(raw.signature),
    ingestedAt: toInt(raw.ingested_at),
    ingestSeq: toInt(raw.ingest_seq),
  };
}

function mapSubmitted(raw: SubmittedRowRaw): StoreTxnSubmittedRow {
  const ids = JSON.parse(raw.message_ids_json) as string[];
  return {
    txHash: raw.tx_hash as Bytes32,
    contentTag: raw.content_tag as Bytes32,
    blobVersionedHash: raw.blob_versioned_hash as Bytes32,
    blockNumber: raw.block_number === null ? null : toInt(raw.block_number),
    status: raw.status as SubmittedBatchStatus,
    replacedByTxHash: (raw.replaced_by_tx_hash ?? null) as Bytes32 | null,
    submittedAt: toInt(raw.submitted_at),
    messageIds: ids as Bytes32[],
    messages: decodeSnapshots(raw.messages_json),
  };
}

export class PostgresPosterStore implements PosterStore {
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
    } finally {
      client.release();
    }
  }

  async withTxn<T>(fn: (txn: StoreTxn) => Promise<T>): Promise<T> {
    await this.ready;
    // PostgreSQL SERIALIZABLE can reject a txn with SQLSTATE 40001
    // (serialization_failure) under concurrent write conflicts. The
    // documented remedy is an application-level retry of the whole
    // txn — the sqlite path sidesteps this with a process-local
    // mutex, postgres needs its own loop (cubic review). Cap retries
    // so a genuinely stuck condition still surfaces.
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
      // Short backoff before retrying so a hot row doesn't busy-loop.
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    }
    // Unreachable: the loop either returns, throws on terminal attempt,
    // or falls through below after MAX_RETRIES serialization failures.
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
          (message_id, content_tag, author, nonce, timestamp, content, signature, ingested_at, ingest_seq)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          row.messageId,
          row.contentTag,
          row.author,
          encodeNonce(row.nonce),
          row.timestamp,
          Buffer.from(row.content),
          Buffer.from(row.signature),
          row.ingestedAt,
          row.ingestSeq,
        ]
      );
    },
    async getPendingByMessageId(messageId: Bytes32): Promise<StoreTxnPendingRow | null> {
      const res = await client.query<PendingRowRaw>(
        'SELECT * FROM poster_pending WHERE message_id = $1',
        [messageId]
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
    async deletePending(messageIds: Bytes32[]): Promise<void> {
      if (messageIds.length === 0) return;
      await client.query('DELETE FROM poster_pending WHERE message_id = ANY($1::text[])', [
        messageIds,
      ]);
    },
    async countPendingByTag(tag: Bytes32): Promise<number> {
      const res = await client.query<{ c: string }>(
        'SELECT COUNT(*)::text AS c FROM poster_pending WHERE content_tag = $1',
        [tag]
      );
      return Number(res.rows[0]?.c ?? 0);
    },
    async nextIngestSeq(tag: Bytes32): Promise<number> {
      // Persistent per-tag counter (see SQLite flavor): DELETEs on
      // poster_pending can't walk ingest_seq backwards.
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

    async getNonce(author: Address): Promise<NonceTrackerRow | null> {
      const res = await client.query<NonceRowRaw>(
        'SELECT * FROM poster_nonces WHERE author = $1',
        [author.toLowerCase()]
      );
      const raw = res.rows[0];
      if (!raw) return null;
      return {
        author: raw.author as Address,
        lastNonce: decodeNonce(raw.last_nonce),
        lastMessageId: raw.last_message_id as Bytes32,
      };
    },
    async setNonce(row: NonceTrackerRow): Promise<void> {
      await client.query(
        `INSERT INTO poster_nonces (author, last_nonce, last_message_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (author) DO UPDATE SET
           last_nonce = EXCLUDED.last_nonce,
           last_message_id = EXCLUDED.last_message_id`,
        [row.author.toLowerCase(), encodeNonce(row.lastNonce), row.lastMessageId]
      );
    },

    async insertSubmitted(row: StoreTxnSubmittedRow): Promise<void> {
      await client.query(
        `INSERT INTO poster_submitted_batches
          (tx_hash, content_tag, blob_versioned_hash, block_number, status,
           replaced_by_tx_hash, submitted_at, message_ids_json, messages_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          row.txHash,
          row.contentTag,
          row.blobVersionedHash,
          row.blockNumber,
          row.status,
          row.replacedByTxHash,
          row.submittedAt,
          JSON.stringify(row.messageIds),
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
      blockNumber: number | null
    ): Promise<void> {
      if (blockNumber !== null) {
        await client.query(
          `UPDATE poster_submitted_batches
             SET status = $1, replaced_by_tx_hash = $2, block_number = $3
           WHERE tx_hash = $4`,
          [status, replacedByTxHash, blockNumber, txHash]
        );
      } else {
        await client.query(
          `UPDATE poster_submitted_batches
             SET status = $1, replaced_by_tx_hash = $2
           WHERE tx_hash = $3`,
          [status, replacedByTxHash, txHash]
        );
      }
    },
  };
}
