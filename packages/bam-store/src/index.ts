/**
 * BAM storage substrate — Node entrypoint.
 *
 * Exposes the persistence types and all three backends (memory / SQLite /
 * Postgres). The browser entrypoint (`./browser`) exposes the memory
 * backend only and is audited to stay free of server-only imports.
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
export { createDbStore, type DbStoreOptions } from './db-store.js';
export { SqliteBamStore } from './sqlite.js';
export { PostgresBamStore } from './postgres.js';
export { SCHEMA_VERSION } from './schema.js';
