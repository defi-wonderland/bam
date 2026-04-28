/**
 * bam-store — browser-safe entrypoint.
 *
 * `createMemoryStore` + the persistence types only. Must NOT
 * transitively import `pg`, `@electric-sql/pglite/node`, `node:fs`,
 * `node:path`, `node:crypto`, etc. The browser bundle audit pins the
 * forbidden import set; see `packages/bam-store/tests/browser-audit.test.ts`.
 */

export type {
  BamStore,
  BatchMessageSnapshotEntry,
  BatchRow,
  BatchStatus,
  BatchesQuery,
  ChainCoord,
  MessageRow,
  MessageStatus,
  MessagesQuery,
  NonceTrackerRow,
  PendingKey,
  ReaderCursorRow,
  StoreTxn,
  StoreTxnPendingRow,
} from './types.js';

export { createMemoryStore } from './create-memory-store.js';
