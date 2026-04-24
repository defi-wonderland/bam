import pg from 'pg';
import type { Address, Bytes32 } from 'bam-sdk';

type PgPool = pg.Pool;
type PgPoolClient = pg.PoolClient;

import type {
  BamStore,
  BatchRow,
  BatchStatus,
  BatchesQuery,
  MessageRow,
  MessageSnapshot,
  MessageStatus,
  MessagesQuery,
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

const BRIDGE_CHAIN_ID = 0;

function isSerializationFailure(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === '40001'
  );
}

interface MessageRowRaw {
  author: string;
  nonce: string;
  content_tag: string;
  contents: Buffer;
  signature: Buffer;
  message_hash: string;
  message_id: string | null;
  status: string;
  batch_ref: string | null;
  ingested_at: string | number | null;
  ingest_seq: string | number | null;
  block_number: string | number | null;
  tx_index: string | number | null;
  message_index_within_batch: string | number | null;
}

interface BatchRowRaw {
  tx_hash: string;
  chain_id: string | number;
  content_tag: string;
  blob_versioned_hash: string;
  batch_content_hash: string;
  block_number: string | number | null;
  tx_index: string | number | null;
  status: string;
  replaced_by_tx_hash: string | null;
  submitted_at: string | number | null;
  invalidated_at: string | number | null;
}

interface CursorRowRaw {
  chain_id: string | number;
  last_block_number: string | number;
  last_tx_index: string | number;
  updated_at: string | number;
}

interface NonceRowRaw {
  sender: string;
  last_nonce: string;
  last_message_hash: string;
}

function toInt(value: string | number): number {
  return typeof value === 'number' ? value : Number(value);
}

function toIntOrNull(value: string | number | null): number | null {
  return value === null || value === undefined ? null : toInt(value);
}

function mapMessage(raw: MessageRowRaw): MessageRow {
  return {
    messageId: (raw.message_id ?? null) as Bytes32 | null,
    author: raw.author as Address,
    nonce: decodeNonce(raw.nonce),
    contentTag: raw.content_tag as Bytes32,
    contents: new Uint8Array(raw.contents),
    signature: new Uint8Array(raw.signature),
    messageHash: raw.message_hash as Bytes32,
    status: raw.status as MessageStatus,
    batchRef: (raw.batch_ref ?? null) as Bytes32 | null,
    ingestedAt: toIntOrNull(raw.ingested_at),
    ingestSeq: toIntOrNull(raw.ingest_seq),
    blockNumber: toIntOrNull(raw.block_number),
    txIndex: toIntOrNull(raw.tx_index),
    messageIndexWithinBatch: toIntOrNull(raw.message_index_within_batch),
  };
}

function mapBatch(raw: BatchRowRaw): BatchRow {
  return {
    txHash: raw.tx_hash as Bytes32,
    chainId: toInt(raw.chain_id),
    contentTag: raw.content_tag as Bytes32,
    blobVersionedHash: raw.blob_versioned_hash as Bytes32,
    batchContentHash: raw.batch_content_hash as Bytes32,
    blockNumber: toIntOrNull(raw.block_number),
    txIndex: toIntOrNull(raw.tx_index),
    status: raw.status as BatchStatus,
    replacedByTxHash: (raw.replaced_by_tx_hash ?? null) as Bytes32 | null,
    submittedAt: toIntOrNull(raw.submitted_at),
    invalidatedAt: toIntOrNull(raw.invalidated_at),
  };
}

function mapPending(raw: MessageRowRaw): StoreTxnPendingRow {
  return {
    contentTag: raw.content_tag as Bytes32,
    sender: raw.author as Address,
    nonce: decodeNonce(raw.nonce),
    contents: new Uint8Array(raw.contents),
    signature: new Uint8Array(raw.signature),
    messageHash: raw.message_hash as Bytes32,
    ingestedAt: toIntOrNull(raw.ingested_at) ?? 0,
    ingestSeq: toIntOrNull(raw.ingest_seq) ?? 0,
  };
}

function oldStatusToBatch(s: SubmittedBatchStatus): BatchStatus {
  switch (s) {
    case 'pending':
      return 'pending_tx';
    case 'included':
      return 'confirmed';
    case 'reorged':
      return 'reorged';
    case 'resubmitted':
      return 'reorged';
  }
}

function batchToOldStatus(b: BatchRow): SubmittedBatchStatus {
  switch (b.status) {
    case 'pending_tx':
      return 'pending';
    case 'confirmed':
      return 'included';
    case 'reorged':
      return b.replacedByTxHash !== null ? 'resubmitted' : 'reorged';
  }
}

function messageStatusForBatch(bs: BatchStatus): MessageStatus {
  switch (bs) {
    case 'pending_tx':
      return 'submitted';
    case 'confirmed':
      return 'confirmed';
    case 'reorged':
      return 'reorged';
  }
}

export class PostgresBamStore implements BamStore {
  private readonly pool: PgPool;
  private ready: Promise<void>;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString });
    this.ready = this.initSchema();
  }

  private async initSchema(): Promise<void> {
    const client = await this.pool.connect();
    try {
      for (const stmt of SQL_CREATE_POSTGRES) {
        await client.query(stmt);
      }
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

function makePgTxn(client: PgPoolClient): StoreTxn {
  async function upsertMessage(row: MessageRow): Promise<void> {
    await client.query(
      `INSERT INTO messages
        (author, nonce, content_tag, contents, signature, message_hash,
         message_id, status, batch_ref, ingested_at, ingest_seq,
         block_number, tx_index, message_index_within_batch)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (author, nonce) DO UPDATE SET
         content_tag                = EXCLUDED.content_tag,
         contents                   = EXCLUDED.contents,
         signature                  = EXCLUDED.signature,
         message_hash               = EXCLUDED.message_hash,
         message_id                 = EXCLUDED.message_id,
         status                     = EXCLUDED.status,
         batch_ref                  = EXCLUDED.batch_ref,
         ingested_at                = EXCLUDED.ingested_at,
         ingest_seq                 = EXCLUDED.ingest_seq,
         block_number               = EXCLUDED.block_number,
         tx_index                   = EXCLUDED.tx_index,
         message_index_within_batch = EXCLUDED.message_index_within_batch`,
      [
        row.author.toLowerCase(),
        encodeNonce(row.nonce),
        row.contentTag,
        Buffer.from(row.contents),
        Buffer.from(row.signature),
        row.messageHash,
        row.messageId,
        row.status,
        row.batchRef,
        row.ingestedAt,
        row.ingestSeq,
        row.blockNumber,
        row.txIndex,
        row.messageIndexWithinBatch,
      ]
    );
  }

  async function collectMessagesForBatch(txHash: Bytes32): Promise<MessageSnapshot[]> {
    const res = await client.query<MessageRowRaw>(
      'SELECT * FROM messages WHERE batch_ref = $1 ORDER BY ingest_seq ASC',
      [txHash]
    );
    return res.rows.map((r) => ({
      sender: r.author as Address,
      nonce: decodeNonce(r.nonce),
      contents: new Uint8Array(r.contents),
      signature: new Uint8Array(r.signature),
      messageHash: r.message_hash as Bytes32,
      messageId: (r.message_id ?? null) as Bytes32 | null,
      originalIngestSeq: toIntOrNull(r.ingest_seq) ?? 0,
    }));
  }

  async function mapBatchToSubmitted(b: BatchRow): Promise<StoreTxnSubmittedRow> {
    const msgs = await collectMessagesForBatch(b.txHash);
    return {
      txHash: b.txHash,
      contentTag: b.contentTag,
      blobVersionedHash: b.blobVersionedHash,
      batchContentHash: b.batchContentHash,
      blockNumber: b.blockNumber,
      status: batchToOldStatus(b),
      replacedByTxHash: b.replacedByTxHash,
      submittedAt: b.submittedAt ?? 0,
      invalidatedAt: b.invalidatedAt,
      messages: msgs,
    };
  }

  return {
    // ── old Poster-facing pending CRUD (bridged) ────────────────────
    async insertPending(row: StoreTxnPendingRow): Promise<void> {
      const existing = await client.query<MessageRowRaw>(
        'SELECT status FROM messages WHERE author = $1 AND nonce = $2',
        [row.sender.toLowerCase(), encodeNonce(row.nonce)]
      );
      if (existing.rows[0]) {
        const s = existing.rows[0].status;
        if (s !== 'reorged' && s !== 'duplicate') {
          throw new Error('insertPending: duplicate (sender, nonce)');
        }
        await client.query(
          'DELETE FROM messages WHERE author = $1 AND nonce = $2',
          [row.sender.toLowerCase(), encodeNonce(row.nonce)]
        );
      }
      await client.query(
        `INSERT INTO messages
          (author, nonce, content_tag, contents, signature, message_hash,
           message_id, status, batch_ref, ingested_at, ingest_seq,
           block_number, tx_index, message_index_within_batch)
         VALUES ($1,$2,$3,$4,$5,$6,NULL,'pending',NULL,$7,$8,NULL,NULL,NULL)`,
        [
          row.sender.toLowerCase(),
          encodeNonce(row.nonce),
          row.contentTag,
          Buffer.from(row.contents),
          Buffer.from(row.signature),
          row.messageHash,
          row.ingestedAt,
          row.ingestSeq,
        ]
      );
    },

    async getPendingByKey(key: PendingKey): Promise<StoreTxnPendingRow | null> {
      const res = await client.query<MessageRowRaw>(
        "SELECT * FROM messages WHERE author = $1 AND nonce = $2 AND status = 'pending'",
        [key.sender.toLowerCase(), encodeNonce(key.nonce)]
      );
      return res.rows[0] ? mapPending(res.rows[0]) : null;
    },

    async listPendingByTag(
      tag: Bytes32,
      limit?: number,
      sinceSeq?: number
    ): Promise<StoreTxnPendingRow[]> {
      const clauses = ["content_tag = $1", "status = 'pending'"];
      const params: Array<string | number> = [tag];
      if (sinceSeq !== undefined) {
        clauses.push(`ingest_seq > $${params.length + 1}`);
        params.push(sinceSeq);
      }
      let sql = `SELECT * FROM messages WHERE ${clauses.join(
        ' AND '
      )} ORDER BY ingest_seq ASC`;
      if (typeof limit === 'number') {
        sql += ` LIMIT $${params.length + 1}`;
        params.push(limit);
      }
      const res = await client.query<MessageRowRaw>(sql, params);
      return res.rows.map(mapPending);
    },

    async listPendingAll(limit?: number, sinceSeq?: number): Promise<StoreTxnPendingRow[]> {
      const clauses = ["status = 'pending'"];
      const params: Array<string | number> = [];
      if (sinceSeq !== undefined) {
        clauses.push(`ingest_seq > $${params.length + 1}`);
        params.push(sinceSeq);
      }
      let sql = `SELECT * FROM messages WHERE ${clauses.join(
        ' AND '
      )} ORDER BY ingested_at ASC, ingest_seq ASC`;
      if (typeof limit === 'number') {
        sql += ` LIMIT $${params.length + 1}`;
        params.push(limit);
      }
      const res = await client.query<MessageRowRaw>(sql, params);
      return res.rows.map(mapPending);
    },

    async deletePending(keys: PendingKey[]): Promise<void> {
      if (keys.length === 0) return;
      const CHUNK = 500;
      for (let i = 0; i < keys.length; i += CHUNK) {
        const slice = keys.slice(i, i + CHUNK);
        const tuples: string[] = [];
        const params: string[] = [];
        for (const k of slice) {
          tuples.push(`($${params.length + 1}, $${params.length + 2})`);
          params.push(k.sender.toLowerCase(), encodeNonce(k.nonce));
        }
        await client.query(
          `DELETE FROM messages
           WHERE status = 'pending' AND (author, nonce) IN (${tuples.join(', ')})`,
          params
        );
      }
    },

    async countPendingByTag(tag: Bytes32): Promise<number> {
      const res = await client.query<{ c: string }>(
        "SELECT COUNT(*) AS c FROM messages WHERE content_tag = $1 AND status = 'pending'",
        [tag]
      );
      return toInt(res.rows[0]?.c ?? 0);
    },

    async nextIngestSeq(tag: Bytes32): Promise<number> {
      const res = await client.query<{ last_seq: string | number }>(
        `INSERT INTO poster_tag_seq (content_tag, last_seq) VALUES ($1, 1)
         ON CONFLICT (content_tag) DO UPDATE SET last_seq = poster_tag_seq.last_seq + 1
         RETURNING last_seq`,
        [tag]
      );
      if (!res.rows[0]) throw new Error('nextIngestSeq: no row returned');
      return toInt(res.rows[0].last_seq);
    },

    // ── nonce tracker ────────────────────────────────────────────────
    async getNonce(sender: Address): Promise<NonceTrackerRow | null> {
      const res = await client.query<NonceRowRaw>(
        'SELECT * FROM poster_nonces WHERE sender = $1',
        [sender.toLowerCase()]
      );
      const r = res.rows[0];
      if (!r) return null;
      return {
        sender: r.sender as Address,
        lastNonce: decodeNonce(r.last_nonce),
        lastMessageHash: r.last_message_hash as Bytes32,
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

    // ── old submitted CRUD (bridged to batches + messages) ───────────
    async insertSubmitted(row: StoreTxnSubmittedRow): Promise<void> {
      const existing = await client.query(
        'SELECT tx_hash FROM batches WHERE tx_hash = $1',
        [row.txHash]
      );
      if (existing.rowCount !== null && existing.rowCount > 0) {
        throw new Error('insertSubmitted: duplicate tx_hash');
      }
      const bs = oldStatusToBatch(row.status);
      await client.query(
        `INSERT INTO batches
          (tx_hash, chain_id, content_tag, blob_versioned_hash,
           batch_content_hash, block_number, tx_index, status,
           replaced_by_tx_hash, submitted_at, invalidated_at)
         VALUES ($1,$2,$3,$4,$5,$6,NULL,$7,$8,$9,$10)`,
        [
          row.txHash,
          BRIDGE_CHAIN_ID,
          row.contentTag,
          row.blobVersionedHash,
          row.batchContentHash,
          row.blockNumber,
          bs,
          row.replacedByTxHash,
          row.submittedAt,
          row.invalidatedAt,
        ]
      );
      for (let i = 0; i < row.messages.length; i++) {
        const m = row.messages[i];
        const ms = messageStatusForBatch(bs);
        await upsertMessage({
          messageId: m.messageId,
          author: m.sender,
          nonce: m.nonce,
          contentTag: row.contentTag,
          contents: m.contents,
          signature: m.signature,
          messageHash: m.messageHash,
          status: ms,
          batchRef: row.txHash,
          ingestedAt: null,
          ingestSeq: m.originalIngestSeq,
          blockNumber: bs === 'confirmed' ? row.blockNumber : null,
          txIndex: null,
          messageIndexWithinBatch: i,
        });
      }
    },

    async getSubmittedByTx(txHash: Bytes32): Promise<StoreTxnSubmittedRow | null> {
      const res = await client.query<BatchRowRaw>(
        'SELECT * FROM batches WHERE tx_hash = $1',
        [txHash]
      );
      if (!res.rows[0]) return null;
      return mapBatchToSubmitted(mapBatch(res.rows[0]));
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
      let sql = 'SELECT * FROM batches';
      if (clauses.length) sql += ' WHERE ' + clauses.join(' AND ');
      sql += ' ORDER BY submitted_at DESC';
      if (typeof query.limit === 'number') {
        sql += ` LIMIT $${params.length + 1}`;
        params.push(query.limit);
      }
      const res = await client.query<BatchRowRaw>(sql, params);
      const out: StoreTxnSubmittedRow[] = [];
      for (const r of res.rows) {
        out.push(await mapBatchToSubmitted(mapBatch(r)));
      }
      return out;
    },

    async updateSubmittedStatus(
      txHash: Bytes32,
      status: SubmittedBatchStatus,
      replacedByTxHash: Bytes32 | null,
      blockNumber: number | null,
      invalidatedAt?: number | null
    ): Promise<void> {
      const bs = oldStatusToBatch(status);
      const sets: string[] = ['status = $1', 'replaced_by_tx_hash = $2'];
      const params: Array<string | number | null> = [bs, replacedByTxHash];
      if (blockNumber !== null) {
        sets.push(`block_number = $${params.length + 1}`);
        params.push(blockNumber);
      }
      if (invalidatedAt !== undefined) {
        sets.push(`invalidated_at = $${params.length + 1}`);
        params.push(invalidatedAt);
      }
      params.push(txHash);
      const res = await client.query(
        `UPDATE batches SET ${sets.join(', ')} WHERE tx_hash = $${params.length}`,
        params
      );
      if (res.rowCount === 0) {
        throw new Error('updateSubmittedStatus: no row for tx_hash');
      }
      if (bs === 'reorged') {
        await client.query(
          `UPDATE messages SET status = 'reorged'
           WHERE batch_ref = $1 AND status IN ('confirmed', 'submitted')`,
          [txHash]
        );
      }
    },

    // ── unified-schema lifecycle transitions ─────────────────────────
    async markSubmitted(keys: PendingKey[], batchRef: Bytes32): Promise<void> {
      if (keys.length === 0) return;
      const CHUNK = 500;
      for (let i = 0; i < keys.length; i += CHUNK) {
        const slice = keys.slice(i, i + CHUNK);
        const tuples: string[] = [];
        const params: Array<string> = [batchRef];
        for (const k of slice) {
          tuples.push(`($${params.length + 1}, $${params.length + 2})`);
          params.push(k.sender.toLowerCase(), encodeNonce(k.nonce));
        }
        const res = await client.query(
          `UPDATE messages SET status = 'submitted', batch_ref = $1
           WHERE status = 'pending'
             AND (author, nonce) IN (${tuples.join(', ')})`,
          params
        );
        if (res.rowCount !== slice.length) {
          throw new Error(
            `markSubmitted: expected ${slice.length} rows updated, got ${res.rowCount}`
          );
        }
      }
    },

    async upsertObserved(row: MessageRow): Promise<void> {
      const existing = await client.query<{ status: string; message_hash: string }>(
        'SELECT status, message_hash FROM messages WHERE author = $1 AND nonce = $2',
        [row.author.toLowerCase(), encodeNonce(row.nonce)]
      );
      const e = existing.rows[0];
      if (e) {
        if (e.status === 'confirmed' && e.message_hash !== row.messageHash) {
          throw new Error(
            'upsertObserved: existing confirmed row has a different messageHash — caller must call markDuplicate'
          );
        }
        if (e.status === 'confirmed' && e.message_hash === row.messageHash) {
          return;
        }
      }
      await upsertMessage(row);
    },

    async markDuplicate(messageHash: Bytes32): Promise<void> {
      const res = await client.query<{ author: string; nonce: string }>(
        "SELECT author, nonce FROM messages WHERE message_hash = $1 AND status != 'confirmed' LIMIT 1",
        [messageHash]
      );
      const r = res.rows[0];
      if (!r) {
        throw new Error(
          `markDuplicate: no non-confirmed row with messageHash=${messageHash}`
        );
      }
      await client.query(
        `UPDATE messages SET status = 'duplicate' WHERE author = $1 AND nonce = $2`,
        [r.author, r.nonce]
      );
    },

    async markReorged(txHash: Bytes32, invalidatedAt: number): Promise<void> {
      const res = await client.query(
        `UPDATE batches SET status = 'reorged', invalidated_at = $1 WHERE tx_hash = $2`,
        [invalidatedAt, txHash]
      );
      if (res.rowCount === 0) {
        throw new Error(`markReorged: no batch for tx_hash=${txHash}`);
      }
      await client.query(
        `UPDATE messages SET status = 'reorged' WHERE batch_ref = $1 AND status = 'confirmed'`,
        [txHash]
      );
    },

    // ── unified-schema reads ─────────────────────────────────────────
    async listMessages(query: MessagesQuery): Promise<MessageRow[]> {
      const clauses: string[] = [];
      const params: Array<string | number> = [];
      if (query.contentTag !== undefined) {
        clauses.push(`content_tag = $${params.length + 1}`);
        params.push(query.contentTag);
      }
      if (query.author !== undefined) {
        clauses.push(`author = $${params.length + 1}`);
        params.push(query.author.toLowerCase());
      }
      if (query.status !== undefined) {
        clauses.push(`status = $${params.length + 1}`);
        params.push(query.status);
      }
      if (query.sinceBlock !== undefined) {
        clauses.push(`block_number IS NOT NULL AND block_number >= $${params.length + 1}`);
        params.push(Number(query.sinceBlock));
      }
      if (query.cursor !== undefined) {
        clauses.push(
          `(block_number, tx_index, message_index_within_batch) > ($${params.length + 1}, $${
            params.length + 2
          }, $${params.length + 3})`
        );
        params.push(
          query.cursor.blockNumber,
          query.cursor.txIndex,
          query.cursor.messageIndexWithinBatch
        );
      }
      let sql = 'SELECT * FROM messages';
      if (clauses.length) sql += ' WHERE ' + clauses.join(' AND ');
      sql +=
        ' ORDER BY (block_number IS NULL) ASC, block_number ASC NULLS LAST, tx_index ASC NULLS LAST, message_index_within_batch ASC NULLS LAST, ingest_seq ASC NULLS LAST';
      if (typeof query.limit === 'number') {
        sql += ` LIMIT $${params.length + 1}`;
        params.push(query.limit);
      }
      const res = await client.query<MessageRowRaw>(sql, params);
      return res.rows.map(mapMessage);
    },

    async getByMessageId(messageId: Bytes32): Promise<MessageRow | null> {
      const res = await client.query<MessageRowRaw>(
        'SELECT * FROM messages WHERE message_id = $1',
        [messageId]
      );
      return res.rows[0] ? mapMessage(res.rows[0]) : null;
    },

    async getByAuthorNonce(author: Address, nonce: bigint): Promise<MessageRow | null> {
      const res = await client.query<MessageRowRaw>(
        'SELECT * FROM messages WHERE author = $1 AND nonce = $2',
        [author.toLowerCase(), encodeNonce(nonce)]
      );
      return res.rows[0] ? mapMessage(res.rows[0]) : null;
    },

    // ── unified-schema batch CRUD ────────────────────────────────────
    async upsertBatch(row: BatchRow): Promise<void> {
      await client.query(
        `INSERT INTO batches
          (tx_hash, chain_id, content_tag, blob_versioned_hash,
           batch_content_hash, block_number, tx_index, status,
           replaced_by_tx_hash, submitted_at, invalidated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (tx_hash) DO UPDATE SET
           chain_id            = EXCLUDED.chain_id,
           content_tag         = EXCLUDED.content_tag,
           blob_versioned_hash = EXCLUDED.blob_versioned_hash,
           batch_content_hash  = EXCLUDED.batch_content_hash,
           block_number        = EXCLUDED.block_number,
           tx_index            = EXCLUDED.tx_index,
           status              = EXCLUDED.status,
           replaced_by_tx_hash = EXCLUDED.replaced_by_tx_hash,
           submitted_at        = EXCLUDED.submitted_at,
           invalidated_at      = EXCLUDED.invalidated_at`,
        [
          row.txHash,
          row.chainId,
          row.contentTag,
          row.blobVersionedHash,
          row.batchContentHash,
          row.blockNumber,
          row.txIndex,
          row.status,
          row.replacedByTxHash,
          row.submittedAt,
          row.invalidatedAt,
        ]
      );
    },

    async updateBatchStatus(
      txHash: Bytes32,
      status: BatchStatus,
      opts?: {
        blockNumber?: number | null;
        txIndex?: number | null;
        replacedByTxHash?: Bytes32 | null;
        invalidatedAt?: number | null;
      }
    ): Promise<void> {
      const sets = ['status = $1'];
      const params: Array<string | number | null> = [status];
      if (opts?.blockNumber !== undefined) {
        sets.push(`block_number = $${params.length + 1}`);
        params.push(opts.blockNumber);
      }
      if (opts?.txIndex !== undefined) {
        sets.push(`tx_index = $${params.length + 1}`);
        params.push(opts.txIndex);
      }
      if (opts?.replacedByTxHash !== undefined) {
        sets.push(`replaced_by_tx_hash = $${params.length + 1}`);
        params.push(opts.replacedByTxHash);
      }
      if (opts?.invalidatedAt !== undefined) {
        sets.push(`invalidated_at = $${params.length + 1}`);
        params.push(opts.invalidatedAt);
      }
      params.push(txHash);
      const res = await client.query(
        `UPDATE batches SET ${sets.join(', ')} WHERE tx_hash = $${params.length}`,
        params
      );
      if (res.rowCount === 0) {
        throw new Error(`updateBatchStatus: no batch for tx_hash=${txHash}`);
      }
    },

    async listBatches(query: BatchesQuery): Promise<BatchRow[]> {
      const clauses: string[] = [];
      const params: Array<string | number> = [];
      if (query.contentTag !== undefined) {
        clauses.push(`content_tag = $${params.length + 1}`);
        params.push(query.contentTag);
      }
      if (query.chainId !== undefined) {
        clauses.push(`chain_id = $${params.length + 1}`);
        params.push(query.chainId);
      }
      if (query.status !== undefined) {
        clauses.push(`status = $${params.length + 1}`);
        params.push(query.status);
      }
      if (query.sinceBlock !== undefined) {
        clauses.push(`block_number IS NOT NULL AND block_number >= $${params.length + 1}`);
        params.push(Number(query.sinceBlock));
      }
      let sql = 'SELECT * FROM batches';
      if (clauses.length) sql += ' WHERE ' + clauses.join(' AND ');
      sql += ' ORDER BY submitted_at DESC';
      if (typeof query.limit === 'number') {
        sql += ` LIMIT $${params.length + 1}`;
        params.push(query.limit);
      }
      const res = await client.query<BatchRowRaw>(sql, params);
      return res.rows.map(mapBatch);
    },

    // ── reader cursor ────────────────────────────────────────────────
    async getCursor(chainId: number): Promise<ReaderCursorRow | null> {
      const res = await client.query<CursorRowRaw>(
        'SELECT * FROM reader_cursor WHERE chain_id = $1',
        [chainId]
      );
      const r = res.rows[0];
      if (!r) return null;
      return {
        chainId: toInt(r.chain_id),
        lastBlockNumber: toInt(r.last_block_number),
        lastTxIndex: toInt(r.last_tx_index),
        updatedAt: toInt(r.updated_at),
      };
    },
    async setCursor(row: ReaderCursorRow): Promise<void> {
      await client.query(
        `INSERT INTO reader_cursor (chain_id, last_block_number, last_tx_index, updated_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (chain_id) DO UPDATE SET
           last_block_number = EXCLUDED.last_block_number,
           last_tx_index     = EXCLUDED.last_tx_index,
           updated_at        = EXCLUDED.updated_at`,
        [row.chainId, row.lastBlockNumber, row.lastTxIndex, row.updatedAt]
      );
    },
  };
}
