/**
 * BAM Reader — Node-only service that observes BlobBatchRegistered events
 * on L1, fetches the corresponding blob bytes, verifies them, dispatches
 * decode and per-message verify, and persists confirmed rows into a
 * shared `bam-store` substrate.
 *
 * @module bam-reader
 */

// Factory + public reader surface.
export { createReader } from './factory.js';
export type { Reader, ReaderHealthSnapshot, ReaderFactoryExtras } from './factory.js';

// Configuration types.
export type { ReaderConfig, ReaderCounters, ReaderEvent } from './types.js';

// Errors.
export {
  ReaderError,
  BlobUnreachable,
  VersionedHashMismatch,
  DecodeDispatchFailed,
  VerifyDispatchFailed,
  ChainIdMismatch,
} from './errors.js';
export type { ReaderErrorReason } from './errors.js';

// Blob fetch surfaces — re-exported so the demo (and future consumers)
// don't need to maintain a parallel copy.
export {
  extractUsableBytes,
  FIELD_ELEMENTS_PER_BLOB,
  BYTES_PER_FIELD_ELEMENT,
  USABLE_BYTES_PER_FIELD_ELEMENT,
  USABLE_BYTES_PER_BLOB,
} from './blob-fetch/extract.js';
export {
  recomputeVersionedHash,
  assertVersionedHashMatches,
  FULL_BLOB_BYTE_LENGTH,
} from './blob-fetch/versioned-hash.js';
export { fetchFromBeaconApi } from './blob-fetch/beacon.js';
export type { BeaconFetchOptions, FetchLike } from './blob-fetch/beacon.js';
export { fetchFromBlobscan } from './blob-fetch/blobscan.js';
export type { BlobscanFetchOptions } from './blob-fetch/blobscan.js';
export { fetchBlob } from './blob-fetch/multi-source.js';
export type {
  MultiSourceOptions,
  BlobSourceEvent,
  BlobSourceLogger,
} from './blob-fetch/multi-source.js';

// Reorg + dispatch + cursor — exposed for callers who want to compose
// rather than use the full factory.
export { DEFAULT_REORG_WINDOW, MIN_REORG_WINDOW, MAX_REORG_WINDOW, clampReorgWindow } from './reorg-watcher.js';
export type { BlockSource } from './reorg-watcher.js';
