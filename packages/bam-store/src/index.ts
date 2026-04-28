/**
 * BAM storage substrate — Node entrypoint.
 *
 * Exposes the persistence types and the Postgres-backed adapter. The
 * `createMemoryStore` factory returns a `PostgresBamStore` over a
 * fresh in-process PGLite instance. The browser entrypoint
 * (`./browser`) wires the same adapter over PGLite's browser build
 * and is audited to stay free of server-only imports.
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
export {
  createDbStore,
  createPostgresStoreFromUrl,
  type DbStoreOptions,
} from './db-store.js';
export { PostgresBamStore } from './postgres.js';
export { SCHEMA_VERSION } from './schema/index.js';
