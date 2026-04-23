import Database from 'better-sqlite3';
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
import { SQL_CREATE_SQLITE } from './schema.js';
import { decodeSnapshots, encodeSnapshots } from './snapshot-codec.js';

interface PendingRowRaw {
  message_id: string;
  content_tag: string;
  author: string;
  nonce: string;
  timestamp: number;
  content: Buffer;
  signature: Buffer;
  ingested_at: number;
  ingest_seq: number;
}

interface SubmittedRowRaw {
  tx_hash: string;
  content_tag: string;
  blob_versioned_hash: string;
  block_number: number | null;
  status: string;
  replaced_by_tx_hash: string | null;
  submitted_at: number;
  message_ids_json: string;
  messages_json: string;
}

interface NonceRowRaw {
  author: string;
  last_nonce: string;
  last_message_id: string;
}

function mapPending(raw: PendingRowRaw): StoreTxnPendingRow {
  return {
    messageId: raw.message_id as Bytes32,
    contentTag: raw.content_tag as Bytes32,
    author: raw.author as Address,
    nonce: decodeNonce(raw.nonce),
    timestamp: raw.timestamp,
    content: new Uint8Array(raw.content),
    signature: new Uint8Array(raw.signature),
    ingestedAt: raw.ingested_at,
    ingestSeq: raw.ingest_seq,
  };
}

function mapSubmitted(raw: SubmittedRowRaw): StoreTxnSubmittedRow {
  const ids = JSON.parse(raw.message_ids_json) as string[];
  return {
    txHash: raw.tx_hash as Bytes32,
    contentTag: raw.content_tag as Bytes32,
    blobVersionedHash: raw.blob_versioned_hash as Bytes32,
    blockNumber: raw.block_number,
    status: raw.status as SubmittedBatchStatus,
    replacedByTxHash: (raw.replaced_by_tx_hash ?? null) as Bytes32 | null,
    submittedAt: raw.submitted_at,
    messageIds: ids as Bytes32[],
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
    // FU-8: block (rather than error) when another connection holds
    // the write lock. 5 s is generous for our txn scopes; if it's
    // still locked after that, something has actually deadlocked.
    this.db.pragma('busy_timeout = 5000');
    for (const stmt of SQL_CREATE_SQLITE) this.db.exec(stmt);
  }

  async withTxn<T>(fn: (txn: StoreTxn) => Promise<T>): Promise<T> {
    // Serialize callers at the process level. SQLite uses BEGIN IMMEDIATE
    // for its own locking, but running async fns inside a single db txn
    // still requires we keep only one in flight at a time.
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
          // ignore rollback-on-already-rolled-back
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
            (message_id, content_tag, author, nonce, timestamp, content, signature, ingested_at, ingest_seq)
           VALUES (@message_id, @content_tag, @author, @nonce, @timestamp, @content, @signature, @ingested_at, @ingest_seq)`
        ).run({
          message_id: row.messageId,
          content_tag: row.contentTag,
          author: row.author,
          nonce: encodeNonce(row.nonce),
          timestamp: row.timestamp,
          content: Buffer.from(row.content),
          signature: Buffer.from(row.signature),
          ingested_at: row.ingestedAt,
          ingest_seq: row.ingestSeq,
        });
      },
      getPendingByMessageId(messageId: Bytes32): StoreTxnPendingRow | null {
        const raw = db
          .prepare('SELECT * FROM poster_pending WHERE message_id = ?')
          .get(messageId) as PendingRowRaw | undefined;
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
      deletePending(messageIds: Bytes32[]): void {
        if (messageIds.length === 0) return;
        // Chunked IN (?, ?, …) so we get the round-trip win for typical
        // batches but don't hit SQLite's SQLITE_MAX_VARIABLE_NUMBER
        // (999 pre-3.32, 32766 after) on the rare large flush (qodo
        // review). 500 is well under the old limit and one statement
        // covers ~every realistic batch.
        const CHUNK = 500;
        for (let i = 0; i < messageIds.length; i += CHUNK) {
          const slice = messageIds.slice(i, i + CHUNK);
          const placeholders = slice.map(() => '?').join(', ');
          db.prepare(`DELETE FROM poster_pending WHERE message_id IN (${placeholders})`).run(
            ...slice
          );
        }
      },
      countPendingByTag(tag: Bytes32): number {
        const row = db
          .prepare('SELECT COUNT(*) AS c FROM poster_pending WHERE content_tag = ?')
          .get(tag) as { c: number } | undefined;
        return row?.c ?? 0;
      },
      nextIngestSeq(tag: Bytes32): number {
        // Counter lives in its own table so DELETE on poster_pending
        // (e.g. after a flush) can't reset the sequence — without this,
        // sinceSeq-based incremental reads would re-see old ingest_seq
        // values and skip rows inserted after the flush (cubic review).
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

      getNonce(author: Address): NonceTrackerRow | null {
        const raw = db
          .prepare('SELECT * FROM poster_nonces WHERE author = ?')
          .get(author.toLowerCase()) as NonceRowRaw | undefined;
        if (!raw) return null;
        return {
          author: raw.author as Address,
          lastNonce: decodeNonce(raw.last_nonce),
          lastMessageId: raw.last_message_id as Bytes32,
        };
      },
      setNonce(row: NonceTrackerRow): void {
        db.prepare(
          `INSERT INTO poster_nonces (author, last_nonce, last_message_id)
           VALUES (?, ?, ?)
           ON CONFLICT(author) DO UPDATE SET
             last_nonce = excluded.last_nonce,
             last_message_id = excluded.last_message_id`
        ).run(row.author.toLowerCase(), encodeNonce(row.lastNonce), row.lastMessageId);
      },

      insertSubmitted(row: StoreTxnSubmittedRow): void {
        db.prepare(
          `INSERT INTO poster_submitted_batches
            (tx_hash, content_tag, blob_versioned_hash, block_number, status,
             replaced_by_tx_hash, submitted_at, message_ids_json, messages_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          row.txHash,
          row.contentTag,
          row.blobVersionedHash,
          row.blockNumber,
          row.status,
          row.replacedByTxHash,
          row.submittedAt,
          JSON.stringify(row.messageIds),
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
        blockNumber: number | null
      ): void {
        // Only update block_number when a non-null value is supplied.
        if (blockNumber !== null) {
          db.prepare(
            `UPDATE poster_submitted_batches
               SET status = ?, replaced_by_tx_hash = ?, block_number = ?
             WHERE tx_hash = ?`
          ).run(status, replacedByTxHash, blockNumber, txHash);
        } else {
          db.prepare(
            `UPDATE poster_submitted_batches
               SET status = ?, replaced_by_tx_hash = ?
             WHERE tx_hash = ?`
          ).run(status, replacedByTxHash, txHash);
        }
      },
    };
  }
}
