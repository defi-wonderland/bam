/**
 * BAM storage substrate — Node entrypoint.
 *
 * Exposes the persistence types and all three backends (memory / SQLite /
 * Postgres). The browser entrypoint (`./browser`) exposes the memory
 * backend only and is audited to stay free of server-only imports.
 */

export type {
  MessageSnapshot,
  NonceTrackerRow,
  PendingKey,
  PosterStore,
  StoreTxn,
  StoreTxnPendingRow,
  StoreTxnSubmittedRow,
  SubmittedBatchStatus,
  SubmittedBatchesQuery,
} from './types.js';

export { createMemoryStore, MemoryPosterStore } from './memory-store.js';
export { createDbStore, type DbStoreOptions } from './db-store.js';
export { SqlitePosterStore } from './sqlite.js';
export { PostgresPosterStore } from './postgres.js';
export { SCHEMA_VERSION } from './schema.js';
