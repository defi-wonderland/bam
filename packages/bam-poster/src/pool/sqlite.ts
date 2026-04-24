import Database from 'better-sqlite3';
import type { Address, Bytes32 } from 'bam-sdk';

import type {
  NonceTrackerRow,
  PendingKey,
  PosterStore,
  StoreTxn,
  StoreTxnPendingRow,
  StoreTxnSubmittedRow,
  SubmittedBatchStatus,
  SubmittedBatchesQuery,
} from '../types.js';
import { decodeNonce, encodeNonce } from './nonce-codec.js';
import { SCHEMA_VERSION, SQL_CREATE_SQLITE } from './schema.js';
import { decodeSnapshots, encodeSnapshots } from './snapshot-codec.js';

interface PendingRowRaw {
  content_tag: string;
  sender: string;
  nonce: string;
  contents: Buffer;
  signature: Buffer;
  message_hash: string;
  ingested_at: number;
  ingest_seq: number;
}

interface SubmittedRowRaw {
  tx_hash: string;
  content_tag: string;
  blob_versioned_hash: string;
  batch_content_hash: string;
  block_number: number | null;
  status: string;
  replaced_by_tx_hash: string | null;
  submitted_at: number;
  invalidated_at: number | null;
  messages_json: string;
}

interface NonceRowRaw {
  sender: string;
  last_nonce: string;
  last_message_hash: string;
}

function mapPending(raw: PendingRowRaw): StoreTxnPendingRow {
  return {
    contentTag: raw.content_tag as Bytes32,
    sender: raw.sender as Address,
    nonce: decodeNonce(raw.nonce),
    contents: new Uint8Array(raw.contents),
    signature: new Uint8Array(raw.signature),
    messageHash: raw.message_hash as Bytes32,
    ingestedAt: raw.ingested_at,
    ingestSeq: raw.ingest_seq,
  };
}

function mapSubmitted(raw: SubmittedRowRaw): StoreTxnSubmittedRow {
  return {
    txHash: raw.tx_hash as Bytes32,
    contentTag: raw.content_tag as Bytes32,
    blobVersionedHash: raw.blob_versioned_hash as Bytes32,
    batchContentHash: raw.batch_content_hash as Bytes32,
    blockNumber: raw.block_number,
    status: raw.status as SubmittedBatchStatus,
    replacedByTxHash: (raw.replaced_by_tx_hash ?? null) as Bytes32 | null,
    submittedAt: raw.submitted_at,
    invalidatedAt: raw.invalidated_at ?? null,
    messages: decodeSnapshots(raw.messages_json),
  };
}

export class SqlitePosterStore implements PosterStore {
  private readonly db: Database.Database;
  private txnChain: Promise<unknown> = Promise.resolve();

  constructor(filename: string) {
    this.db = new Database(filename);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    for (const stmt of SQL_CREATE_SQLITE) this.db.exec(stmt);
    // Initialise / verify schema version in the same transaction as
    // the CREATE TABLE IF NOT EXISTS statements above — so a fresh DB
    // gets tagged with the current version, and an existing stale DB
    // surfaces its `version` row unchanged for the startup
    // reconciliation guard.
    this.initSchemaVersion();
  }

  private initSchemaVersion(): void {
    const row = this.db
      .prepare('SELECT version FROM poster_schema LIMIT 1')
      .get() as { version: number } | undefined;
    if (row === undefined) {
      this.db.prepare('INSERT INTO poster_schema (version) VALUES (?)').run(SCHEMA_VERSION);
    }
  }

  /** Returns the persisted schema version — used by `startup/reconcile.ts`. */
  readSchemaVersion(): number {
    const row = this.db
      .prepare('SELECT version FROM poster_schema LIMIT 1')
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
    return {
      insertPending(row: StoreTxnPendingRow): void {
        db.prepare(
          `INSERT INTO poster_pending
            (content_tag, sender, nonce, contents, signature, message_hash, ingested_at, ingest_seq)
           VALUES (@content_tag, @sender, @nonce, @contents, @signature, @message_hash, @ingested_at, @ingest_seq)`
        ).run({
          content_tag: row.contentTag,
          sender: row.sender.toLowerCase(),
          nonce: encodeNonce(row.nonce),
          contents: Buffer.from(row.contents),
          signature: Buffer.from(row.signature),
          message_hash: row.messageHash,
          ingested_at: row.ingestedAt,
          ingest_seq: row.ingestSeq,
        });
      },
      getPendingByKey(key: PendingKey): StoreTxnPendingRow | null {
        const raw = db
          .prepare('SELECT * FROM poster_pending WHERE sender = ? AND nonce = ?')
          .get(key.sender.toLowerCase(), encodeNonce(key.nonce)) as
          | PendingRowRaw
          | undefined;
        return raw ? mapPending(raw) : null;
      },
      listPendingByTag(
        tag: Bytes32,
        limit?: number,
        sinceSeq?: number
      ): StoreTxnPendingRow[] {
        const clauses: string[] = ['content_tag = ?'];
        const params: Array<string | number> = [tag];
        if (sinceSeq !== undefined) {
          clauses.push('ingest_seq > ?');
          params.push(sinceSeq);
        }
        let sql = `SELECT * FROM poster_pending WHERE ${clauses.join(' AND ')} ORDER BY ingest_seq ASC`;
        if (typeof limit === 'number') {
          sql += ' LIMIT ?';
          params.push(limit);
        }
        const rows = db.prepare(sql).all(...params) as PendingRowRaw[];
        return rows.map(mapPending);
      },
      listPendingAll(limit?: number, sinceSeq?: number): StoreTxnPendingRow[] {
        const clauses: string[] = [];
        const params: Array<string | number> = [];
        if (sinceSeq !== undefined) {
          clauses.push('ingest_seq > ?');
          params.push(sinceSeq);
        }
        let sql = `SELECT * FROM poster_pending${clauses.length ? ' WHERE ' + clauses.join(' AND ') : ''}
          ORDER BY ingested_at ASC, ingest_seq ASC`;
        if (typeof limit === 'number') {
          sql += ' LIMIT ?';
          params.push(limit);
        }
        const rows = db.prepare(sql).all(...params) as PendingRowRaw[];
        return rows.map(mapPending);
      },
      deletePending(keys: PendingKey[]): void {
        if (keys.length === 0) return;
        const CHUNK = 500;
        for (let i = 0; i < keys.length; i += CHUNK) {
          const slice = keys.slice(i, i + CHUNK);
          const placeholders = slice.map(() => '(?, ?)').join(', ');
          const params: string[] = [];
          for (const k of slice) {
            params.push(k.sender.toLowerCase(), encodeNonce(k.nonce));
          }
          db.prepare(
            `DELETE FROM poster_pending WHERE (sender, nonce) IN (VALUES ${placeholders})`
          ).run(...params);
        }
      },
      countPendingByTag(tag: Bytes32): number {
        const row = db
          .prepare('SELECT COUNT(*) AS c FROM poster_pending WHERE content_tag = ?')
          .get(tag) as { c: number } | undefined;
        return row?.c ?? 0;
      },
      nextIngestSeq(tag: Bytes32): number {
        const row = db
          .prepare(
            `INSERT INTO poster_tag_seq (content_tag, last_seq) VALUES (?, 1)
             ON CONFLICT(content_tag) DO UPDATE SET last_seq = last_seq + 1
             RETURNING last_seq`
          )
          .get(tag) as { last_seq: number } | undefined;
        if (row === undefined) {
          throw new Error('nextIngestSeq: INSERT ... RETURNING produced no row');
        }
        return row.last_seq;
      },

      getNonce(sender: Address): NonceTrackerRow | null {
        const raw = db
          .prepare('SELECT * FROM poster_nonces WHERE sender = ?')
          .get(sender.toLowerCase()) as NonceRowRaw | undefined;
        if (!raw) return null;
        return {
          sender: raw.sender as Address,
          lastNonce: decodeNonce(raw.last_nonce),
          lastMessageHash: raw.last_message_hash as Bytes32,
        };
      },
      setNonce(row: NonceTrackerRow): void {
        db.prepare(
          `INSERT INTO poster_nonces (sender, last_nonce, last_message_hash)
           VALUES (?, ?, ?)
           ON CONFLICT(sender) DO UPDATE SET
             last_nonce = excluded.last_nonce,
             last_message_hash = excluded.last_message_hash`
        ).run(row.sender.toLowerCase(), encodeNonce(row.lastNonce), row.lastMessageHash);
      },

      insertSubmitted(row: StoreTxnSubmittedRow): void {
        db.prepare(
          `INSERT INTO poster_submitted_batches
            (tx_hash, content_tag, blob_versioned_hash, batch_content_hash,
             block_number, status, replaced_by_tx_hash, submitted_at,
             invalidated_at, messages_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          row.txHash,
          row.contentTag,
          row.blobVersionedHash,
          row.batchContentHash,
          row.blockNumber,
          row.status,
          row.replacedByTxHash,
          row.submittedAt,
          row.invalidatedAt,
          encodeSnapshots(row.messages)
        );
      },
      getSubmittedByTx(txHash: Bytes32): StoreTxnSubmittedRow | null {
        const raw = db
          .prepare('SELECT * FROM poster_submitted_batches WHERE tx_hash = ?')
          .get(txHash) as SubmittedRowRaw | undefined;
        return raw ? mapSubmitted(raw) : null;
      },
      listSubmitted(query: SubmittedBatchesQuery): StoreTxnSubmittedRow[] {
        const clauses: string[] = [];
        const params: Array<string | number> = [];
        if (query.contentTag !== undefined) {
          clauses.push('content_tag = ?');
          params.push(query.contentTag);
        }
        if (query.sinceBlock !== undefined) {
          clauses.push('block_number IS NOT NULL AND block_number >= ?');
          params.push(Number(query.sinceBlock));
        }
        let sql = `SELECT * FROM poster_submitted_batches${clauses.length ? ' WHERE ' + clauses.join(' AND ') : ''}
          ORDER BY submitted_at DESC`;
        if (typeof query.limit === 'number') {
          sql += ' LIMIT ?';
          params.push(query.limit);
        }
        const rows = db.prepare(sql).all(...params) as SubmittedRowRaw[];
        return rows.map(mapSubmitted);
      },
      updateSubmittedStatus(
        txHash: Bytes32,
        status: SubmittedBatchStatus,
        replacedByTxHash: Bytes32 | null,
        blockNumber: number | null,
        invalidatedAt?: number | null
      ): void {
        const setClauses = ['status = ?', 'replaced_by_tx_hash = ?'];
        const setParams: Array<string | number | null> = [status, replacedByTxHash];
        if (blockNumber !== null) {
          setClauses.push('block_number = ?');
          setParams.push(blockNumber);
        }
        if (invalidatedAt !== undefined) {
          setClauses.push('invalidated_at = ?');
          setParams.push(invalidatedAt);
        }
        db.prepare(
          `UPDATE poster_submitted_batches SET ${setClauses.join(', ')} WHERE tx_hash = ?`
        ).run(...setParams, txHash);
      },
    };
  }
}
