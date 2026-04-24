/**
 * bam-store — browser-safe entrypoint.
 *
 * Memory backend + the persistence types only. Must NOT transitively
 * import better-sqlite3, pg, node:fs, node:path, node:crypto, etc.
 * See T011's audit (recorded on the PR): `grep better-sqlite3|pg|^\s*node:|fs|path`
 * over the compiled transitive closure of this file returns zero hits.
 */

export type {
  BamStore,
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

export { createMemoryStore, MemoryBamStore } from './memory-store.js';
