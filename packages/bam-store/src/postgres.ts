import { and, asc, eq, gt, gte, isNotNull, sql } from 'drizzle-orm';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { PGlite } from '@electric-sql/pglite';
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
import { SCHEMA_VERSION } from './schema/index.js';
import {
  bamStoreSchema,
  batches as batchesT,
  messages as messagesT,
  nonces as noncesT,
  readerCursor as readerCursorT,
  tagSeq as tagSeqT,
} from './schema/tables.js';
import { SQL_CREATE_DDL } from './schema/ddl.js';
import {
  decodeMessageSnapshot,
  encodeMessageSnapshot,
} from './snapshot-codec.js';

/**
 * Driver-agnostic Drizzle handle the adapter operates against. Both
 * `drizzle-orm/pglite` and `drizzle-orm/node-postgres` produce values
 * that conform to this base shape; the URL factory in `db-store.ts`
 * builds one externally so this file does not need to reach `pg`.
 */
export type DrizzleDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/**
 * Arbitrary 64-bit key used to serialize concurrent bootstrap (DDL +
 * singleton seed) across processes. The exact value is irrelevant —
 * only consistency across writers attached to the same database
 * matters. Held for the duration of the bootstrap transaction; released
 * automatically on commit/rollback.
 */
const BOOTSTRAP_LOCK_KEY = 8_267_831_923_821n;

function execRowCount(res: unknown): number {
  if (typeof res !== 'object' || res === null) return 0;
  const r = res as { rowCount?: number | null; affectedRows?: number | null };
  // node-postgres reports `rowCount`; PGLite reports `affectedRows`.
  return r.rowCount ?? r.affectedRows ?? 0;
}

function isSerializationFailure(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (code === '40001') return true;
  // Drizzle wraps the underlying driver error on transaction; the cause
  // chain carries the original `code`.
  const cause = (err as { cause?: unknown }).cause;
  if (cause) return isSerializationFailure(cause);
  return false;
}

function asUint8(value: Uint8Array): Uint8Array {
  // `Buffer` is a `Uint8Array` subclass; `value.constructor === Uint8Array`
  // distinguishes a plain typed array from a Buffer without naming
  // `Buffer` itself (which doesn't exist in browsers).
  return value.constructor === Uint8Array ? value : new Uint8Array(value);
}

interface RawMessage {
  author: string;
  nonce: string;
  contentTag: string;
  // node-postgres returns Buffer (a Uint8Array subclass) and PGLite
  // returns plain Uint8Array — `Uint8Array` covers both without
  // naming the Node-only `Buffer` global.
  contents: Uint8Array;
  signature: Uint8Array;
  messageHash: string;
  messageId: string | null;
  status: string;
  batchRef: string | null;
  ingestedAt: number | null;
  ingestSeq: number | null;
  blockNumber: number | null;
  txIndex: number | null;
  messageIndexWithinBatch: number | null;
}

interface RawBatch {
  txHash: string;
  chainId: number;
  contentTag: string;
  blobVersionedHash: string;
  batchContentHash: string;
  blockNumber: number | null;
  txIndex: number | null;
  status: string;
  replacedByTxHash: string | null;
  submittedAt: number | null;
  invalidatedAt: number | null;
  messageSnapshot: string;
  submitter: string | null;
  l1IncludedAtUnixSec: number | null;
}

function mapMessage(raw: RawMessage): MessageRow {
  return {
    messageId: raw.messageId as Bytes32 | null,
    author: raw.author as Address,
    nonce: decodeNonce(raw.nonce),
    contentTag: raw.contentTag as Bytes32,
    contents: asUint8(raw.contents),
    signature: asUint8(raw.signature),
    messageHash: raw.messageHash as Bytes32,
    status: raw.status as MessageStatus,
    batchRef: raw.batchRef as Bytes32 | null,
    ingestedAt: raw.ingestedAt,
    ingestSeq: raw.ingestSeq,
    blockNumber: raw.blockNumber,
    txIndex: raw.txIndex,
    messageIndexWithinBatch: raw.messageIndexWithinBatch,
  };
}

function mapBatch(raw: RawBatch): BatchRow {
  return {
    txHash: raw.txHash as Bytes32,
    chainId: raw.chainId,
    contentTag: raw.contentTag as Bytes32,
    blobVersionedHash: raw.blobVersionedHash as Bytes32,
    batchContentHash: raw.batchContentHash as Bytes32,
    blockNumber: raw.blockNumber,
    txIndex: raw.txIndex,
    status: raw.status as BatchStatus,
    replacedByTxHash: raw.replacedByTxHash as Bytes32 | null,
    submittedAt: raw.submittedAt,
    invalidatedAt: raw.invalidatedAt,
    submitter: raw.submitter as Address | null,
    l1IncludedAtUnixSec: raw.l1IncludedAtUnixSec,
    messageSnapshot: decodeMessageSnapshot(raw.messageSnapshot),
  };
}

function mapPending(raw: RawMessage): StoreTxnPendingRow {
  // `insertPending` always writes ingestedAt + ingestSeq, but the columns
  // are nullable to accommodate observed-only rows that never went through
  // the pending pool. A pending row missing either is a write-path bug,
  // not a state we should silently coerce to 0.
  if (raw.ingestedAt === null || raw.ingestSeq === null) {
    throw new Error(
      `mapPending: pending row (${raw.author}, ${raw.nonce}) has null ingest metadata`
    );
  }
  return {
    contentTag: raw.contentTag as Bytes32,
    sender: raw.author as Address,
    nonce: decodeNonce(raw.nonce),
    contents: asUint8(raw.contents),
    signature: asUint8(raw.signature),
    messageHash: raw.messageHash as Bytes32,
    ingestedAt: raw.ingestedAt,
    ingestSeq: raw.ingestSeq,
  };
}

/**
 * Pre-built Drizzle handle plus an optional cleanup callback. Used by
 * the Node-only URL factory in `db-store.ts` to construct a
 * `PostgresBamStore` over a `pg.Pool` without making `postgres.ts`
 * statically reach `pg` (which would pull `pg` into the browser
 * bundle through `bam-store/browser`).
 */
export interface PostgresBamStoreInit {
  db: DrizzleDb;
  cleanup?: () => Promise<void>;
}

export class PostgresBamStore implements BamStore {
  private readonly db: DrizzleDb;
  private readonly cleanup: (() => Promise<void>) | null;

  private constructor(db: DrizzleDb, cleanup: (() => Promise<void>) | null) {
    this.db = db;
    this.cleanup = cleanup;
  }

  /**
   * Construct a `PostgresBamStore` over the supplied driver and run the
   * bootstrap (DDL + singleton schema-version row) before returning.
   * Construction errors surface from this `await`, not from the first
   * subsequent operation.
   *
   * When passed a raw `PGlite` instance the caller owns its lifecycle
   * by default — `close()` does not touch it. Pass
   * `{ cleanup: () => db.close() }` (the shape `createMemoryStore` uses)
   * to transfer ownership so `close()` releases the PGLite resources.
   */
  static async open(
    connection: PGlite | PostgresBamStoreInit,
    options?: { cleanup?: () => Promise<void> }
  ): Promise<PostgresBamStore> {
    let db: DrizzleDb;
    let cleanup: (() => Promise<void>) | null;
    if (connection instanceof PGlite) {
      db = drizzlePglite(connection) as unknown as DrizzleDb;
      cleanup = options?.cleanup ?? null;
    } else {
      db = connection.db;
      cleanup = connection.cleanup ?? null;
    }
    // Run DDL + singleton seed inside one transaction guarded by a
    // transaction-scoped advisory lock (`pg_advisory_xact_lock`, auto-
    // released on commit/rollback). `CREATE TABLE IF NOT EXISTS` on its
    // own is *not* race-safe in Postgres — two concurrent transactions
    // can both pass the existence check and then collide on the
    // pg_type / pg_class system-catalog unique indexes. The advisory
    // lock serialises bootstraps across processes; the second writer
    // waits, then re-runs the DDL against an already-populated catalog
    // where IF NOT EXISTS short-circuits cleanly.
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${BOOTSTRAP_LOCK_KEY}::bigint)`
      );
      for (const stmt of SQL_CREATE_DDL) {
        await tx.execute(sql.raw(stmt));
      }
      // Singleton row pattern (id=1 with CHECK) plus ON CONFLICT means
      // concurrent initialisations and mixed-version writers cannot grow
      // the table beyond one row, so reads are deterministic. The
      // version-mismatch check itself is owned by `reconcileSchemaVersion`,
      // which runs separately.
      await tx
        .insert(bamStoreSchema)
        .values({ id: 1, version: SCHEMA_VERSION })
        .onConflictDoNothing({ target: bamStoreSchema.id });
    });
    return new PostgresBamStore(db, cleanup);
  }

  async readSchemaVersion(): Promise<number> {
    const rows = await this.db
      .select({ version: bamStoreSchema.version })
      .from(bamStoreSchema)
      .where(eq(bamStoreSchema.id, 1));
    const row = rows[0];
    if (!row) {
      // `open()` always seeds the singleton row via INSERT ... ON
      // CONFLICT DO NOTHING, so an empty table indicates the bootstrap
      // never ran or someone deleted the row out from under us. Refuse
      // it loudly rather than returning a fabricated SCHEMA_VERSION
      // that would silently green-light the reconciler.
      throw new Error(
        'readSchemaVersion: bam_store_schema is empty. Drop the store ' +
          'tables and restart so the adapter can re-bootstrap.'
      );
    }
    return row.version;
  }

  async withTxn<T>(fn: (txn: StoreTxn) => Promise<T>): Promise<T> {
    const MAX_RETRIES = 5;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await this.db.transaction(
          async (tx) => fn(makeTxn(tx as unknown as DrizzleDb)),
          { isolationLevel: 'serializable' }
        );
      } catch (err) {
        if (!isSerializationFailure(err) || attempt === MAX_RETRIES) {
          throw err;
        }
        lastErr = err;
        await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
      }
    }
    throw lastErr ?? new Error('withTxn: exhausted serialization retries');
  }

  async close(): Promise<void> {
    if (this.cleanup) {
      await this.cleanup();
    }
    // PGLite instances are owned by the caller; we don't close them here.
  }
}

function makeTxn(tx: DrizzleDb): StoreTxn {
  return {
    // ── pending CRUD (bridged to messages) ──────────────────────────
    async insertPending(row: StoreTxnPendingRow): Promise<void> {
      const author = row.sender.toLowerCase();
      const nonce = encodeNonce(row.nonce);
      const existing = await tx
        .select({ status: messagesT.status })
        .from(messagesT)
        .where(and(eq(messagesT.author, author), eq(messagesT.nonce, nonce)));
      if (existing[0]) {
        if (existing[0].status !== 'reorged') {
          throw new Error('insertPending: duplicate (sender, nonce)');
        }
        await tx
          .delete(messagesT)
          .where(and(eq(messagesT.author, author), eq(messagesT.nonce, nonce)));
      }
      await tx.insert(messagesT).values({
        author,
        nonce,
        contentTag: row.contentTag,
        contents: row.contents,
        signature: row.signature,
        messageHash: row.messageHash,
        messageId: null,
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
      const rows = await tx
        .select()
        .from(messagesT)
        .where(
          and(
            eq(messagesT.author, key.sender.toLowerCase()),
            eq(messagesT.nonce, encodeNonce(key.nonce)),
            eq(messagesT.status, 'pending')
          )
        );
      return rows[0] ? mapPending(rows[0] as unknown as RawMessage) : null;
    },

    async listPendingByTag(
      tag: Bytes32,
      limit?: number,
      sinceSeq?: number
    ): Promise<StoreTxnPendingRow[]> {
      const where = and(
        eq(messagesT.contentTag, tag),
        eq(messagesT.status, 'pending'),
        sinceSeq !== undefined ? gt(messagesT.ingestSeq, sinceSeq) : undefined
      );
      let q = tx.select().from(messagesT).where(where).orderBy(asc(messagesT.ingestSeq)).$dynamic();
      if (typeof limit === 'number') q = q.limit(limit);
      const rows = await q;
      return rows.map((r) => mapPending(r as unknown as RawMessage));
    },

    async listPendingAll(limit?: number, sinceSeq?: number): Promise<StoreTxnPendingRow[]> {
      const where = and(
        eq(messagesT.status, 'pending'),
        sinceSeq !== undefined ? gt(messagesT.ingestSeq, sinceSeq) : undefined
      );
      let q = tx
        .select()
        .from(messagesT)
        .where(where)
        .orderBy(asc(messagesT.ingestedAt), asc(messagesT.ingestSeq))
        .$dynamic();
      if (typeof limit === 'number') q = q.limit(limit);
      const rows = await q;
      return rows.map((r) => mapPending(r as unknown as RawMessage));
    },

    async countPendingByTag(tag: Bytes32): Promise<number> {
      const rows = await tx
        .select({ c: sql<string | number>`COUNT(*)` })
        .from(messagesT)
        .where(and(eq(messagesT.contentTag, tag), eq(messagesT.status, 'pending')));
      const c = rows[0]?.c ?? 0;
      return typeof c === 'number' ? c : Number(c);
    },

    async nextIngestSeq(tag: Bytes32): Promise<number> {
      const rows = await tx
        .insert(tagSeqT)
        .values({ contentTag: tag, lastSeq: 1 })
        .onConflictDoUpdate({
          target: tagSeqT.contentTag,
          set: { lastSeq: sql`${tagSeqT.lastSeq} + 1` },
        })
        .returning({ lastSeq: tagSeqT.lastSeq });
      const v = rows[0]?.lastSeq;
      if (v === undefined || v === null) {
        throw new Error('nextIngestSeq: no row returned');
      }
      return typeof v === 'number' ? v : Number(v);
    },

    // ── nonce tracker ────────────────────────────────────────────────
    async getNonce(sender: Address): Promise<NonceTrackerRow | null> {
      const rows = await tx
        .select()
        .from(noncesT)
        .where(eq(noncesT.sender, sender.toLowerCase()));
      const r = rows[0];
      if (!r) return null;
      return {
        sender: r.sender as Address,
        lastNonce: decodeNonce(r.lastNonce),
        lastMessageHash: r.lastMessageHash as Bytes32,
      };
    },
    async setNonce(row: NonceTrackerRow): Promise<void> {
      const sender = row.sender.toLowerCase();
      await tx
        .insert(noncesT)
        .values({
          sender,
          lastNonce: encodeNonce(row.lastNonce),
          lastMessageHash: row.lastMessageHash,
        })
        .onConflictDoUpdate({
          target: noncesT.sender,
          set: {
            lastNonce: encodeNonce(row.lastNonce),
            lastMessageHash: row.lastMessageHash,
          },
        });
    },

    // ── unified-schema lifecycle transitions ─────────────────────────
    async markSubmitted(keys: PendingKey[], batchRef: Bytes32): Promise<void> {
      if (keys.length === 0) return;
      const CHUNK = 500;
      for (let i = 0; i < keys.length; i += CHUNK) {
        const slice = keys.slice(i, i + CHUNK);
        const tuples = slice.map(
          (k) => sql`(${k.sender.toLowerCase()}, ${encodeNonce(k.nonce)})`
        );
        const tupleList = sql.join(tuples, sql`, `);
        const res = await tx.execute(sql`
          UPDATE messages SET status = 'submitted', batch_ref = ${batchRef}
          WHERE status = 'pending'
            AND (author, nonce) IN (${tupleList})
        `);
        const rowCount = execRowCount(res);
        if (rowCount !== slice.length) {
          throw new Error(
            `markSubmitted: expected ${slice.length} rows updated, got ${rowCount}`
          );
        }
      }
    },

    async upsertObserved(row: MessageRow): Promise<void> {
      const author = row.author.toLowerCase();
      const nonce = encodeNonce(row.nonce);
      const existing = await tx.execute<{
        status: string;
        message_hash: string;
      }>(sql`
        SELECT status, message_hash FROM messages
        WHERE author = ${author} AND nonce = ${nonce}
      `);
      const existingRow = (existing as { rows: Array<{ status: string; message_hash: string }> })
        .rows[0];
      if (existingRow) {
        if (existingRow.message_hash !== row.messageHash) {
          throw new Error(
            'upsertObserved: existing row has a different messageHash at the same (author, nonce). ' +
              'The nonce-replay-across-batchers duplicate flow is deferred to 004-reader.'
          );
        }
        if (existingRow.status === 'confirmed') {
          return;
        }
      }
      await tx.execute(sql`
        INSERT INTO messages
          (author, nonce, content_tag, contents, signature, message_hash,
           message_id, status, batch_ref, ingested_at, ingest_seq,
           block_number, tx_index, message_index_within_batch)
        VALUES (${author}, ${nonce}, ${row.contentTag},
                ${row.contents}, ${row.signature},
                ${row.messageHash}, ${row.messageId}, ${row.status},
                ${row.batchRef}, ${row.ingestedAt}, ${row.ingestSeq},
                ${row.blockNumber}, ${row.txIndex},
                ${row.messageIndexWithinBatch})
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
          message_index_within_batch = EXCLUDED.message_index_within_batch
      `);
    },

    async markReorged(txHash: Bytes32, invalidatedAt: number): Promise<void> {
      const res = await tx
        .update(batchesT)
        .set({ status: 'reorged', invalidatedAt })
        .where(eq(batchesT.txHash, txHash));
      if (execRowCount(res) === 0) {
        throw new Error(`markReorged: no batch for tx_hash=${txHash}`);
      }
      await tx
        .update(messagesT)
        .set({ status: 'reorged' })
        .where(and(eq(messagesT.batchRef, txHash), eq(messagesT.status, 'confirmed')));
    },

    // ── unified-schema reads ─────────────────────────────────────────
    async listMessages(query: MessagesQuery): Promise<MessageRow[]> {
      const conds = [
        query.contentTag !== undefined ? eq(messagesT.contentTag, query.contentTag) : undefined,
        query.author !== undefined ? eq(messagesT.author, query.author.toLowerCase()) : undefined,
        query.status !== undefined ? eq(messagesT.status, query.status) : undefined,
        query.batchRef !== undefined ? eq(messagesT.batchRef, query.batchRef) : undefined,
        query.sinceBlock !== undefined
          ? and(isNotNull(messagesT.blockNumber), gte(messagesT.blockNumber, Number(query.sinceBlock)))
          : undefined,
        query.cursor !== undefined
          ? sql`(${messagesT.blockNumber}, ${messagesT.txIndex}, ${messagesT.messageIndexWithinBatch}) > (${query.cursor.blockNumber}, ${query.cursor.txIndex}, ${query.cursor.messageIndexWithinBatch})`
          : undefined,
      ];
      const where = and(...conds);
      let q = tx
        .select()
        .from(messagesT)
        .where(where)
        .orderBy(
          sql`(${messagesT.blockNumber} IS NULL) ASC`,
          sql`${messagesT.blockNumber} ASC NULLS LAST`,
          sql`${messagesT.txIndex} ASC NULLS LAST`,
          sql`${messagesT.messageIndexWithinBatch} ASC NULLS LAST`,
          sql`${messagesT.ingestSeq} ASC NULLS LAST`
        )
        .$dynamic();
      if (typeof query.limit === 'number') q = q.limit(query.limit);
      const rows = await q;
      return rows.map((r) => mapMessage(r as unknown as RawMessage));
    },

    async getByMessageId(messageId: Bytes32): Promise<MessageRow | null> {
      const rows = await tx
        .select()
        .from(messagesT)
        .where(eq(messagesT.messageId, messageId));
      return rows[0] ? mapMessage(rows[0] as unknown as RawMessage) : null;
    },

    async getByAuthorNonce(author: Address, nonce: bigint): Promise<MessageRow | null> {
      const rows = await tx
        .select()
        .from(messagesT)
        .where(
          and(
            eq(messagesT.author, author.toLowerCase()),
            eq(messagesT.nonce, encodeNonce(nonce))
          )
        );
      return rows[0] ? mapMessage(rows[0] as unknown as RawMessage) : null;
    },

    // ── unified-schema batch CRUD ────────────────────────────────────
    async upsertBatch(row: BatchRow): Promise<void> {
      const snapshotJson = encodeMessageSnapshot(row.messageSnapshot);
      // Lowercase `submitter` so reader-observed (event topic) and
      // Poster-written (signer.account().address) writers compare and
      // index against the same canonical form.
      const submitter = row.submitter ? row.submitter.toLowerCase() : null;
      await tx.execute(sql`
        INSERT INTO batches
          (tx_hash, chain_id, content_tag, blob_versioned_hash,
           batch_content_hash, block_number, tx_index, status,
           replaced_by_tx_hash, submitted_at, invalidated_at, message_snapshot,
           submitter, l1_included_at_unix_sec)
        VALUES (${row.txHash}, ${row.chainId}, ${row.contentTag},
                ${row.blobVersionedHash}, ${row.batchContentHash},
                ${row.blockNumber}, ${row.txIndex}, ${row.status},
                ${row.replacedByTxHash}, ${row.submittedAt},
                ${row.invalidatedAt}, ${snapshotJson},
                ${submitter}, ${row.l1IncludedAtUnixSec})
        ON CONFLICT (tx_hash) DO UPDATE SET
          chain_id                = EXCLUDED.chain_id,
          content_tag             = EXCLUDED.content_tag,
          blob_versioned_hash     = EXCLUDED.blob_versioned_hash,
          batch_content_hash      = EXCLUDED.batch_content_hash,
          block_number            = EXCLUDED.block_number,
          tx_index                = EXCLUDED.tx_index,
          status                  = EXCLUDED.status,
          replaced_by_tx_hash     = COALESCE(EXCLUDED.replaced_by_tx_hash, batches.replaced_by_tx_hash),
          submitted_at            = COALESCE(EXCLUDED.submitted_at, batches.submitted_at),
          invalidated_at          = EXCLUDED.invalidated_at,
          submitter               = COALESCE(EXCLUDED.submitter, batches.submitter),
          l1_included_at_unix_sec = COALESCE(EXCLUDED.l1_included_at_unix_sec, batches.l1_included_at_unix_sec),
          message_snapshot        = CASE
            WHEN EXCLUDED.message_snapshot = '[]' THEN batches.message_snapshot
            ELSE EXCLUDED.message_snapshot
          END
      `);
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
      const set: Record<string, unknown> = { status };
      if (opts?.blockNumber !== undefined) set.blockNumber = opts.blockNumber;
      if (opts?.txIndex !== undefined) set.txIndex = opts.txIndex;
      if (opts?.replacedByTxHash !== undefined) set.replacedByTxHash = opts.replacedByTxHash;
      if (opts?.invalidatedAt !== undefined) set.invalidatedAt = opts.invalidatedAt;
      const res = await tx.update(batchesT).set(set).where(eq(batchesT.txHash, txHash));
      if (execRowCount(res) === 0) {
        throw new Error(`updateBatchStatus: no batch for tx_hash=${txHash}`);
      }
    },

    async getBatchByTxHash(
      chainId: number,
      txHash: Bytes32
    ): Promise<BatchRow | null> {
      const rows = await tx
        .select()
        .from(batchesT)
        .where(and(eq(batchesT.chainId, chainId), eq(batchesT.txHash, txHash)));
      return rows[0] ? mapBatch(rows[0] as unknown as RawBatch) : null;
    },

    async listBatches(query: BatchesQuery): Promise<BatchRow[]> {
      const conds = [
        query.contentTag !== undefined ? eq(batchesT.contentTag, query.contentTag) : undefined,
        query.chainId !== undefined ? eq(batchesT.chainId, query.chainId) : undefined,
        query.status !== undefined ? eq(batchesT.status, query.status) : undefined,
        query.sinceBlock !== undefined
          ? and(isNotNull(batchesT.blockNumber), gte(batchesT.blockNumber, Number(query.sinceBlock)))
          : undefined,
      ];
      const where = and(...conds);
      let q = tx
        .select()
        .from(batchesT)
        // Stable order for confirmed rows (which may have a null
        // `submitted_at` in Reader-only deploys, since the Poster is
        // the only writer that sets it). Falls back to the L1
        // ordering keys, then `submitted_at` so pending_tx rows
        // (which DO have `submitted_at` but no `block_number` yet)
        // still tail the list deterministically.
        .where(where)
        .orderBy(
          sql`${batchesT.blockNumber} DESC NULLS LAST`,
          sql`${batchesT.txIndex} DESC NULLS LAST`,
          sql`${batchesT.submittedAt} DESC NULLS LAST`
        )
        .$dynamic();
      if (typeof query.limit === 'number') q = q.limit(query.limit);
      const rows = await q;
      return rows.map((r) => mapBatch(r as unknown as RawBatch));
    },

    // ── reader cursor ────────────────────────────────────────────────
    async getCursor(chainId: number): Promise<ReaderCursorRow | null> {
      const rows = await tx
        .select()
        .from(readerCursorT)
        .where(eq(readerCursorT.chainId, chainId));
      const r = rows[0];
      if (!r) return null;
      return {
        chainId: r.chainId,
        lastBlockNumber: r.lastBlockNumber,
        lastTxIndex: r.lastTxIndex,
        updatedAt: r.updatedAt,
      };
    },
    async setCursor(row: ReaderCursorRow): Promise<void> {
      await tx
        .insert(readerCursorT)
        .values({
          chainId: row.chainId,
          lastBlockNumber: row.lastBlockNumber,
          lastTxIndex: row.lastTxIndex,
          updatedAt: row.updatedAt,
        })
        .onConflictDoUpdate({
          target: readerCursorT.chainId,
          set: {
            lastBlockNumber: row.lastBlockNumber,
            lastTxIndex: row.lastTxIndex,
            updatedAt: row.updatedAt,
          },
        });
    },
  };
}

