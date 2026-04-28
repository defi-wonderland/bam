/**
 * Durable schema for the BAM storage substrate. Created on first
 * startup by the DB adapter; no migration library — the schema-version
 * guard in `startup/reconcile.ts` refuses DBs written under an earlier
 * version rather than auto-migrating.
 *
 * Nonces are stored as zero-padded TEXT(20) per `nonce-codec.ts`.
 *
 * `batches.message_snapshot` is a JSON-encoded
 * `BatchMessageSnapshotEntry[]` written at confirmation. The snapshot is
 * how the substrate represents the M:N batch ↔ messages relationship
 * without a join table: a single message's `(author, nonce)` may appear
 * in multiple batches' snapshots over its lifecycle (resubmission after
 * reorg), while `messages.batch_ref` only ever holds the latest batch.
 * Adapters preserve a non-empty snapshot across upserts.
 */

export const SCHEMA_VERSION = 4;

export {
  bamStoreSchema,
  batches,
  messages,
  nonces,
  readerCursor,
  tagSeq,
} from './tables.js';
