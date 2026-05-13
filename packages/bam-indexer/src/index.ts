/**
 * `bam-indexer` — Node service that consumes confirmed BAM messages
 * from `bam-store`, materializes app-shaped entities per
 * `contentTag` via in-tree handlers, augments with on-chain reads,
 * and serves a multi-consumer REST API.
 *
 * @module bam-indexer
 */

export { createIndexer } from './factory.js';
export type {
  Indexer,
  IndexerFactoryExtras,
} from './factory.js';

export type {
  IndexerConfig,
  IndexerCounters,
  HandlerCounters,
  IndexerEvent,
  IndexerEventName,
  IndexerLogger,
} from './types.js';

export {
  IndexerError,
  EnvConfigError,
  ChainIdMismatch,
  UnknownHandlerError,
} from './errors.js';
export type { IndexerErrorReason } from './errors.js';

// Framework — exported so tests and out-of-band tools can compose.
export type {
  IndexerHandler,
  EnrichmentRequest,
  EnrichmentResult,
  BoundHandlerRoute,
} from './framework/handler.js';
export { HandlerRegistry } from './framework/registry.js';
export { migrate, resetHandler } from './framework/migrate.js';
export { tick } from './framework/tick.js';
export {
  CURSOR_GENESIS,
  INDEXER_SCHEMA,
  CURSOR_TABLE,
  CREATE_INDEXER_SCHEMA_SQL,
  getCursor,
  upsertCursor,
  deleteCursor,
} from './framework/cursor.js';
export type { HandlerCursor } from './framework/cursor.js';

// Source.
export {
  BamStoreSource,
} from './source/bam-store-source.js';
export type { ChainCoord, ReorgEntry } from './source/bam-store-source.js';

// Enrichers.
export { EnsEnricher } from './enrichers/ens.js';
export { BatchEnricherPool } from './enrichers/batch.js';
export type { EnricherPool, EnrichmentKind } from './enrichers/types.js';

// HTTP.
export { IndexerHttpServer } from './http/server.js';

// Twitter handler — published so consumers can use it from
// `createIndexer({ ... }, { handlers: [twitterHandler] })`.
export { twitterHandler, TWITTER_TAG } from './handlers/twitter/handler.js';
export { TWITTER_SCHEMA_NAME, TWITTER_DDL } from './handlers/twitter/schema.js';
