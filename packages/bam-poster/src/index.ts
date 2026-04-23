/**
 * BAM Poster — Node-only library that ingests signed messages, holds them
 * in a durable pending pool, and submits them to L1 as blob batches via
 * the BAM Core contract.
 *
 * @module @bam/poster
 */

export { createPoster, _clearSignerRegistryForTests } from './factory.js';
export type { PosterFactoryExtras, InternalPoster } from './factory.js';

export type {
  PosterConfig,
  Poster,
  SubmitResult,
  SubmitHint,
  Pending,
  PendingQuery,
  MessageCursor,
  SubmittedBatch,
  SubmittedBatchMessage,
  SubmittedBatchesQuery,
  SubmittedBatchStatus,
  Status,
  Health,
  HealthState,
  MessageValidator,
  ValidationResult,
  BatchPolicy,
  PoolView,
  Signer,
  DecodedMessage,
  PosterStore,
  StoreTxn,
  StoreTxnPendingRow,
  StoreTxnSubmittedRow,
  NonceTrackerRow,
  MessageSnapshot,
  RateLimitConfig,
  BackoffConfig,
} from './types.js';

export type { PosterRejection } from './errors.js';
export { POSTER_REJECTIONS } from './errors.js';

export { LocalEcdsaSigner } from './signer/local.js';
export { createMemoryStore, MemoryPosterStore } from './pool/memory-store.js';
export { createDbStore, type DbStoreOptions } from './pool/db-store.js';
export { SqlitePosterStore } from './pool/sqlite.js';
export { PostgresPosterStore } from './pool/postgres.js';

export { defaultEcdsaValidator } from './validator/default-ecdsa.js';
export {
  defaultBatchPolicy,
  DEFAULT_BLOB_CAPACITY_BYTES,
  type DefaultBatchPolicyConfig,
} from './policy/default.js';
export { DEFAULT_MAX_MESSAGE_SIZE_BYTES } from './ingest/size-bound.js';
export { DEFAULT_RATE_LIMIT } from './ingest/rate-limit.js';
export { DEFAULT_BACKOFF } from './submission/backoff.js';
export {
  DEFAULT_REORG_WINDOW,
  MIN_REORG_WINDOW,
  MAX_REORG_WINDOW,
  clampReorgWindow,
  type BlockSource,
} from './submission/reorg-watcher.js';
export type { BuildAndSubmit, SubmitOutcome } from './submission/types.js';
export type { ReconcileRpcClient } from './startup/reconcile.js';
export type { StatusRpcReader } from './surfaces/status.js';
export { HttpServer, mountHttp } from './http/server.js';
