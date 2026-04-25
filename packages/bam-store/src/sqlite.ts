import Database from 'better-sqlite3';
import type { Address, Bytes32 } from 'bam-sdk';

import type {
  BamStore,
  BatchRow,
  BatchStatus,
  BatchesQuery,
  MessageRow,
  MessageStatus,
  MessagesQuery,
  NonceTrackerRow,
  PendingKey,
  ReaderCursorRow,
  StoreTxn,
  StoreTxnPendingRow,
} from './types.js';
import { decodeNonce, encodeNonce } from './nonce-codec.js';
import { SCHEMA_VERSION, SQL_CREATE_SQLITE } from './schema.js';
import {
  decodeMessageSnapshot,
  encodeMessageSnapshot,
} from './snapshot-codec.js';

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
  ingested_at: number | null;
  ingest_seq: number | null;
  block_number: number | null;
  tx_index: number | null;
  message_index_within_batch: number | null;
}

interface BatchRowRaw {
  tx_hash: string;
  chain_id: number;
  content_tag: string;
  blob_versioned_hash: string;
  batch_content_hash: string;
  block_number: number | null;
  tx_index: number | null;
  status: string;
  replaced_by_tx_hash: string | null;
  submitted_at: number | null;
  invalidated_at: number | null;
  message_snapshot: string;
}

interface CursorRowRaw {
  chain_id: number;
  last_block_number: number;
  last_tx_index: number;
  updated_at: number;
}

interface NonceRowRaw {
  sender: string;
  last_nonce: string;
  last_message_hash: string;
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
    ingestedAt: raw.ingested_at,
    ingestSeq: raw.ingest_seq,
    blockNumber: raw.block_number,
    txIndex: raw.tx_index,
    messageIndexWithinBatch: raw.message_index_within_batch,
  };
}

function mapBatch(raw: BatchRowRaw): BatchRow {
  return {
    txHash: raw.tx_hash as Bytes32,
    chainId: raw.chain_id,
    contentTag: raw.content_tag as Bytes32,
    blobVersionedHash: raw.blob_versioned_hash as Bytes32,
    batchContentHash: raw.batch_content_hash as Bytes32,
    blockNumber: raw.block_number,
    txIndex: raw.tx_index,
    status: raw.status as BatchStatus,
    replacedByTxHash: (raw.replaced_by_tx_hash ?? null) as Bytes32 | null,
    submittedAt: raw.submitted_at,
    invalidatedAt: raw.invalidated_at,
    messageSnapshot: decodeMessageSnapshot(raw.message_snapshot),
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
    ingestedAt: raw.ingested_at ?? 0,
    ingestSeq: raw.ingest_seq ?? 0,
  };
}

export class SqliteBamStore implements BamStore {
  private readonly db: Database.Database;
  private txnChain: Promise<unknown> = Promise.resolve();

  constructor(filename: string) {
    this.db = new Database(filename);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    for (const stmt of SQL_CREATE_SQLITE) this.db.exec(stmt);
    this.initSchemaVersion();
  }

  private initSchemaVersion(): void {
    // The singleton row pattern (id=1) plus ON CONFLICT means concurrent
    // initialisations and mixed-version writers cannot grow the table
    // beyond one row.
    this.db
      .prepare(
        'INSERT INTO bam_store_schema (id, version) VALUES (1, ?) ON CONFLICT(id) DO NOTHING'
      )
      .run(SCHEMA_VERSION);
  }

  readSchemaVersion(): number {
    const row = this.db
      .prepare('SELECT version FROM bam_store_schema WHERE id = 1')
      .get() as { version: number } | undefined;
    return row?.version ?? SCHEMA_VERSION;
  }

  async withTxn<T>(fn: (txn: StoreTxn) => Promise<T>): Promise<T> {
    const next = this.txnChain.then(async () => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const txn = this.makeTxn();
        const result = await fn(txn);
        this.db.exec('COMMIT');
        return result;
      } catch (err) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          // rollback-on-already-rolled-back
        }
        throw err;
      }
    });
    this.txnChain = next.catch(() => undefined);
    return next;
  }

  async close(): Promise<void> {
    this.db.close();
  }

  private makeTxn(): StoreTxn {
    const db = this.db;

    const selectMsgByKey = db.prepare(
      'SELECT * FROM messages WHERE author = ? AND nonce = ?'
    );

    function insertMessage(row: MessageRow): void {
      db.prepare(
        `INSERT INTO messages
          (author, nonce, content_tag, contents, signature, message_hash,
           message_id, status, batch_ref, ingested_at, ingest_seq,
           block_number, tx_index, message_index_within_batch)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
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
        row.messageIndexWithinBatch
      );
    }

    function upsertMessage(row: MessageRow): void {
      db.prepare(
        `INSERT INTO messages
          (author, nonce, content_tag, contents, signature, message_hash,
           message_id, status, batch_ref, ingested_at, ingest_seq,
           block_number, tx_index, message_index_within_batch)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(author, nonce) DO UPDATE SET
           content_tag                = excluded.content_tag,
           contents                   = excluded.contents,
           signature                  = excluded.signature,
           message_hash               = excluded.message_hash,
           message_id                 = excluded.message_id,
           status                     = excluded.status,
           batch_ref                  = excluded.batch_ref,
           ingested_at                = excluded.ingested_at,
           ingest_seq                 = excluded.ingest_seq,
           block_number               = excluded.block_number,
           tx_index                   = excluded.tx_index,
           message_index_within_batch = excluded.message_index_within_batch`
      ).run(
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
        row.messageIndexWithinBatch
      );
    }

    return {
      // ── pending CRUD (bridged to `messages`) ──────────────────────
      async insertPending(row: StoreTxnPendingRow): Promise<void> {
        const existing = selectMsgByKey.get(
          row.sender.toLowerCase(),
          encodeNonce(row.nonce)
        ) as MessageRowRaw | undefined;
        if (existing) {
          if (existing.status !== 'reorged') {
            throw new Error('insertPending: duplicate (sender, nonce)');
          }
          // Overwrite the stale terminal row with a fresh pending one.
          db.prepare('DELETE FROM messages WHERE author = ? AND nonce = ?').run(
            row.sender.toLowerCase(),
            encodeNonce(row.nonce)
          );
        }
        insertMessage({
          messageId: null,
          author: row.sender,
          nonce: row.nonce,
          contentTag: row.contentTag,
          contents: row.contents,
          signature: row.signature,
          messageHash: row.messageHash,
          status: 'pending',
          batchRef: null,
          ingestedAt: row.ingestedAt,
          ingestSeq: row.ingestSeq,
          blockNumber: null,
          txIndex: null,
          messageIndexWithinBatch: null,
        });
      },

      async getPendingByKey(key: PendingKey): Promise<StoreTxnPendingRow | null> {
        const raw = db
          .prepare(
            "SELECT * FROM messages WHERE author = ? AND nonce = ? AND status = 'pending'"
          )
          .get(key.sender.toLowerCase(), encodeNonce(key.nonce)) as
          | MessageRowRaw
          | undefined;
        return raw ? mapPending(raw) : null;
      },

      async listPendingByTag(
        tag: Bytes32,
        limit?: number,
        sinceSeq?: number
      ): Promise<StoreTxnPendingRow[]> {
        const clauses: string[] = ["content_tag = ?", "status = 'pending'"];
        const params: Array<string | number> = [tag];
        if (sinceSeq !== undefined) {
          clauses.push('ingest_seq > ?');
          params.push(sinceSeq);
        }
        let sql = `SELECT * FROM messages WHERE ${clauses.join(
          ' AND '
        )} ORDER BY ingest_seq ASC`;
        if (typeof limit === 'number') {
          sql += ' LIMIT ?';
          params.push(limit);
        }
        const rows = db.prepare(sql).all(...params) as MessageRowRaw[];
        return rows.map(mapPending);
      },

      async listPendingAll(limit?: number, sinceSeq?: number): Promise<StoreTxnPendingRow[]> {
        const clauses: string[] = ["status = 'pending'"];
        const params: Array<string | number> = [];
        if (sinceSeq !== undefined) {
          clauses.push('ingest_seq > ?');
          params.push(sinceSeq);
        }
        let sql = `SELECT * FROM messages WHERE ${clauses.join(
          ' AND '
        )} ORDER BY ingested_at ASC, ingest_seq ASC`;
        if (typeof limit === 'number') {
          sql += ' LIMIT ?';
          params.push(limit);
        }
        const rows = db.prepare(sql).all(...params) as MessageRowRaw[];
        return rows.map(mapPending);
      },

      async countPendingByTag(tag: Bytes32): Promise<number> {
        const row = db
          .prepare(
            "SELECT COUNT(*) AS c FROM messages WHERE content_tag = ? AND status = 'pending'"
          )
          .get(tag) as { c: number } | undefined;
        return row?.c ?? 0;
      },

      async nextIngestSeq(tag: Bytes32): Promise<number> {
        const row = db
          .prepare(
            `INSERT INTO tag_seq (content_tag, last_seq) VALUES (?, 1)
             ON CONFLICT(content_tag) DO UPDATE SET last_seq = last_seq + 1
             RETURNING last_seq`
          )
          .get(tag) as { last_seq: number } | undefined;
        if (row === undefined) {
          throw new Error('nextIngestSeq: INSERT ... RETURNING produced no row');
        }
        return row.last_seq;
      },

      // ── nonce tracker ────────────────────────────────────────────────
      async getNonce(sender: Address): Promise<NonceTrackerRow | null> {
        const raw = db
          .prepare('SELECT * FROM nonces WHERE sender = ?')
          .get(sender.toLowerCase()) as NonceRowRaw | undefined;
        if (!raw) return null;
        return {
          sender: raw.sender as Address,
          lastNonce: decodeNonce(raw.last_nonce),
          lastMessageHash: raw.last_message_hash as Bytes32,
        };
      },
      async setNonce(row: NonceTrackerRow): Promise<void> {
        db.prepare(
          `INSERT INTO nonces (sender, last_nonce, last_message_hash)
           VALUES (?, ?, ?)
           ON CONFLICT(sender) DO UPDATE SET
             last_nonce = excluded.last_nonce,
             last_message_hash = excluded.last_message_hash`
        ).run(row.sender.toLowerCase(), encodeNonce(row.lastNonce), row.lastMessageHash);
      },

      // ── unified-schema lifecycle transitions ─────────────────────────
      async markSubmitted(keys: PendingKey[], batchRef: Bytes32): Promise<void> {
        if (keys.length === 0) return;
        const CHUNK = 500;
        for (let i = 0; i < keys.length; i += CHUNK) {
          const slice = keys.slice(i, i + CHUNK);
          const placeholders = slice.map(() => '(?, ?)').join(', ');
          const params: string[] = [];
          for (const k of slice) {
            params.push(k.sender.toLowerCase(), encodeNonce(k.nonce));
          }
          const res = db
            .prepare(
              `UPDATE messages SET status = 'submitted', batch_ref = ?
               WHERE status = 'pending'
                 AND (author, nonce) IN (VALUES ${placeholders})`
            )
            .run(batchRef, ...params);
          if (res.changes !== slice.length) {
            throw new Error(
              `markSubmitted: expected ${slice.length} rows updated, got ${res.changes}`
            );
          }
        }
      },

      async upsertObserved(row: MessageRow): Promise<void> {
        const existing = selectMsgByKey.get(
          row.author.toLowerCase(),
          encodeNonce(row.nonce)
        ) as MessageRowRaw | undefined;
        if (existing) {
          if (existing.message_hash !== row.messageHash) {
            throw new Error(
              'upsertObserved: existing row has a different messageHash at the same (author, nonce). ' +
                'The nonce-replay-across-batchers duplicate flow is deferred to 004-reader.'
            );
          }
          if (existing.status === 'confirmed') {
            return;
          }
        }
        upsertMessage(row);
      },

      async markReorged(txHash: Bytes32, invalidatedAt: number): Promise<void> {
        const res = db
          .prepare(
            `UPDATE batches SET status = 'reorged', invalidated_at = ? WHERE tx_hash = ?`
          )
          .run(invalidatedAt, txHash);
        if (res.changes === 0) {
          throw new Error(`markReorged: no batch for tx_hash=${txHash}`);
        }
        db.prepare(
          `UPDATE messages SET status = 'reorged' WHERE batch_ref = ? AND status = 'confirmed'`
        ).run(txHash);
      },

      // ── unified-schema reads ─────────────────────────────────────────
      async listMessages(query: MessagesQuery): Promise<MessageRow[]> {
        const clauses: string[] = [];
        const params: Array<string | number> = [];
        if (query.contentTag !== undefined) {
          clauses.push('content_tag = ?');
          params.push(query.contentTag);
        }
        if (query.author !== undefined) {
          clauses.push('author = ?');
          params.push(query.author.toLowerCase());
        }
        if (query.status !== undefined) {
          clauses.push('status = ?');
          params.push(query.status);
        }
        if (query.batchRef !== undefined) {
          clauses.push('batch_ref = ?');
          params.push(query.batchRef);
        }
        if (query.sinceBlock !== undefined) {
          clauses.push('block_number IS NOT NULL AND block_number >= ?');
          params.push(Number(query.sinceBlock));
        }
        if (query.cursor !== undefined) {
          // Strictly after (blockNumber, txIndex, messageIndexWithinBatch).
          clauses.push(
            '(block_number, tx_index, message_index_within_batch) > (?, ?, ?)'
          );
          params.push(
            query.cursor.blockNumber,
            query.cursor.txIndex,
            query.cursor.messageIndexWithinBatch
          );
        }
        // Rows with NULL chain coords sort after rows with coords, in
        // ingest_seq order (matches memory-store semantics).
        let sql = `SELECT * FROM messages${
          clauses.length ? ' WHERE ' + clauses.join(' AND ') : ''
        } ORDER BY
          (block_number IS NULL) ASC,
          block_number ASC,
          tx_index ASC,
          message_index_within_batch ASC,
          ingest_seq ASC`;
        if (typeof query.limit === 'number') {
          sql += ' LIMIT ?';
          params.push(query.limit);
        }
        const rows = db.prepare(sql).all(...params) as MessageRowRaw[];
        return rows.map(mapMessage);
      },

      async getByMessageId(messageId: Bytes32): Promise<MessageRow | null> {
        const raw = db
          .prepare('SELECT * FROM messages WHERE message_id = ?')
          .get(messageId) as MessageRowRaw | undefined;
        return raw ? mapMessage(raw) : null;
      },

      async getByAuthorNonce(author: Address, nonce: bigint): Promise<MessageRow | null> {
        const raw = selectMsgByKey.get(
          author.toLowerCase(),
          encodeNonce(nonce)
        ) as MessageRowRaw | undefined;
        return raw ? mapMessage(raw) : null;
      },

      // ── unified-schema batch CRUD ────────────────────────────────────
      async upsertBatch(row: BatchRow): Promise<void> {
        const snapshotJson = encodeMessageSnapshot(row.messageSnapshot);
        // Preserve first-writer's snapshot if the new caller's is empty.
        // COALESCE submitted_at + replaced_by_tx_hash so a second writer's
        // null doesn't clobber the first writer's value.
        db.prepare(
          `INSERT INTO batches
            (tx_hash, chain_id, content_tag, blob_versioned_hash,
             batch_content_hash, block_number, tx_index, status,
             replaced_by_tx_hash, submitted_at, invalidated_at, message_snapshot)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(tx_hash) DO UPDATE SET
             chain_id             = excluded.chain_id,
             content_tag          = excluded.content_tag,
             blob_versioned_hash  = excluded.blob_versioned_hash,
             batch_content_hash   = excluded.batch_content_hash,
             block_number         = excluded.block_number,
             tx_index             = excluded.tx_index,
             status               = excluded.status,
             replaced_by_tx_hash  = COALESCE(excluded.replaced_by_tx_hash, batches.replaced_by_tx_hash),
             submitted_at         = COALESCE(excluded.submitted_at, batches.submitted_at),
             invalidated_at       = excluded.invalidated_at,
             message_snapshot     = CASE
               WHEN excluded.message_snapshot = '[]' THEN batches.message_snapshot
               ELSE excluded.message_snapshot
             END`
        ).run(
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
          snapshotJson
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
        const sets = ['status = ?'];
        const params: Array<string | number | null> = [status];
        if (opts?.blockNumber !== undefined) {
          sets.push('block_number = ?');
          params.push(opts.blockNumber);
        }
        if (opts?.txIndex !== undefined) {
          sets.push('tx_index = ?');
          params.push(opts.txIndex);
        }
        if (opts?.replacedByTxHash !== undefined) {
          sets.push('replaced_by_tx_hash = ?');
          params.push(opts.replacedByTxHash);
        }
        if (opts?.invalidatedAt !== undefined) {
          sets.push('invalidated_at = ?');
          params.push(opts.invalidatedAt);
        }
        const res = db
          .prepare(`UPDATE batches SET ${sets.join(', ')} WHERE tx_hash = ?`)
          .run(...params, txHash);
        if (res.changes === 0) {
          throw new Error(`updateBatchStatus: no batch for tx_hash=${txHash}`);
        }
      },

      async listBatches(query: BatchesQuery): Promise<BatchRow[]> {
        const clauses: string[] = [];
        const params: Array<string | number> = [];
        if (query.contentTag !== undefined) {
          clauses.push('content_tag = ?');
          params.push(query.contentTag);
        }
        if (query.chainId !== undefined) {
          clauses.push('chain_id = ?');
          params.push(query.chainId);
        }
        if (query.status !== undefined) {
          clauses.push('status = ?');
          params.push(query.status);
        }
        if (query.sinceBlock !== undefined) {
          clauses.push('block_number IS NOT NULL AND block_number >= ?');
          params.push(Number(query.sinceBlock));
        }
        let sql = `SELECT * FROM batches${
          clauses.length ? ' WHERE ' + clauses.join(' AND ') : ''
        } ORDER BY submitted_at DESC`;
        if (typeof query.limit === 'number') {
          sql += ' LIMIT ?';
          params.push(query.limit);
        }
        const rows = db.prepare(sql).all(...params) as BatchRowRaw[];
        return rows.map(mapBatch);
      },

      // ── reader cursor ────────────────────────────────────────────────
      async getCursor(chainId: number): Promise<ReaderCursorRow | null> {
        const raw = db
          .prepare('SELECT * FROM reader_cursor WHERE chain_id = ?')
          .get(chainId) as CursorRowRaw | undefined;
        if (!raw) return null;
        return {
          chainId: raw.chain_id,
          lastBlockNumber: raw.last_block_number,
          lastTxIndex: raw.last_tx_index,
          updatedAt: raw.updated_at,
        };
      },
      async setCursor(row: ReaderCursorRow): Promise<void> {
        db.prepare(
          `INSERT INTO reader_cursor
            (chain_id, last_block_number, last_tx_index, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(chain_id) DO UPDATE SET
             last_block_number = excluded.last_block_number,
             last_tx_index     = excluded.last_tx_index,
             updated_at        = excluded.updated_at`
        ).run(row.chainId, row.lastBlockNumber, row.lastTxIndex, row.updatedAt);
      },
    };
  }
}

