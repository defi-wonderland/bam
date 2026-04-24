/**
 * Public types and interfaces for the BAM Poster library.
 *
 * Messages flow as `BAMMessage`-shaped records (`sender, nonce, contents`)
 * where `contents[0..32]` is the authoritative `contentTag`. App-level
 * structure lives inside the app-opaque portion of `contents`.
 */

import type { Address, Bytes32 } from 'bam-sdk';
import type {
  BamStore,
  BatchRow,
  MessageRow,
  MessageSnapshot,
  NonceTrackerRow,
  PendingKey,
  StoreTxn,
  StoreTxnPendingRow,
  StoreTxnSubmittedRow,
  SubmittedBatchStatus,
  SubmittedBatchesQuery,
} from 'bam-store';
import type { Account } from 'viem';

import type { PosterRejection } from './errors.js';

// Persistence types live in `bam-store`; re-exported here so external
// consumers of `bam-poster`'s public types are unaffected by the move.
export type {
  BamStore,
  BatchRow,
  MessageRow,
  MessageSnapshot,
  NonceTrackerRow,
  PendingKey,
  StoreTxn,
  StoreTxnPendingRow,
  StoreTxnSubmittedRow,
  SubmittedBatchStatus,
  SubmittedBatchesQuery,
};

// ═══════════════════════════════════════════════════════════════════════
// Submit API
// ═══════════════════════════════════════════════════════════════════════

/**
 * Optional transport-supplied hint. The hint is advisory only — the tag
 * bound in `contents[0..32]` is the authoritative source. Any mismatch
 * is rejected at ingest before signature verification.
 */
export interface SubmitHint {
  contentTag?: Bytes32;
}

export type SubmitResult =
  | { accepted: true; messageHash: Bytes32 }
  | { accepted: false; reason: PosterRejection };

// ═══════════════════════════════════════════════════════════════════════
// Decoded message (post-validator, pre-pool representation)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Canonical internal representation of a signed, well-formed message.
 * `contents` is the full byte string including the 32-byte `contentTag`
 * prefix; `contents[0..32]` and the top-level `contentTag` are guaranteed
 * equal after the ingest's `checkContentTag` stage.
 */
export interface DecodedMessage {
  /** Signed sender (recovered address or asserted + checked). */
  sender: Address;
  /** Per-sender sequential counter. uint64. */
  nonce: bigint;
  /** Full signed content bytes (tag prefix + app-opaque payload). */
  contents: Uint8Array;
  /** Authoritative content tag = `contents[0..32]`. */
  contentTag: Bytes32;
  /** Raw signature bytes (65-byte ECDSA for scheme 0x01). */
  signature: Uint8Array;
  /** ERC-8180 messageHash: keccak256(sender || nonce || contents). Stable client-facing pre-batch identifier. */
  messageHash: Bytes32;
  /** Poster-side ingest time, ms since epoch; populated once the message has been inserted. */
  ingestedAt?: number;
}

// ═══════════════════════════════════════════════════════════════════════
// Pool read surface
// ═══════════════════════════════════════════════════════════════════════

export interface Pending {
  sender: Address;
  nonce: bigint;
  contentTag: Bytes32;
  contents: Uint8Array;
  signature: Uint8Array;
  messageHash: Bytes32;
  ingestedAt: number;
  ingestSeq: number;
}

export interface MessageCursor {
  ingestSeq: number;
  contentTag: Bytes32;
}

export interface PendingQuery {
  contentTag?: Bytes32;
  since?: MessageCursor;
  limit?: number;
}

// ═══════════════════════════════════════════════════════════════════════
// Submitted-batch read surface
// ═══════════════════════════════════════════════════════════════════════

/**
 * Per-message entry on a submitted batch. `messageHash` is stable from
 * ingest onward; `messageId` is ERC-8180's batch-scoped id, computable
 * only after the batch has been assembled (populated on submit) and
 * reset to `null` if the batch is reorged out within the tolerance window.
 */
export interface SubmittedBatchMessage {
  sender: Address;
  nonce: bigint;
  contents: Uint8Array;
  signature: Uint8Array;
  messageHash: Bytes32;
  messageId: Bytes32 | null;
}

export interface SubmittedBatch {
  txHash: Bytes32;
  contentTag: Bytes32;
  blobVersionedHash: Bytes32;
  /** ERC-8180 contentHash for the batch — blob versioned hash or `keccak256(batchData)`. */
  batchContentHash: Bytes32;
  blockNumber: number | null;
  status: SubmittedBatchStatus;
  replacedByTxHash: Bytes32 | null;
  submittedAt: number;
  /** ms since epoch when `status` transitioned to `'reorged'`. */
  invalidatedAt: number | null;
  messages: SubmittedBatchMessage[];
}

// ═══════════════════════════════════════════════════════════════════════
// Status + health (disjoint surfaces)
// ═══════════════════════════════════════════════════════════════════════

export interface Status {
  walletAddress: Address;
  walletBalanceWei: bigint;
  configuredTags: Bytes32[];
  pendingByTag: Array<{ contentTag: Bytes32; count: number }>;
  lastSubmittedByTag: Array<{
    contentTag: Bytes32;
    txHash: Bytes32;
    blobVersionedHash: Bytes32;
    blockNumber: number | null;
    submittedAt: number;
  }>;
}

export type HealthState = 'ok' | 'degraded' | 'unhealthy';

export interface Health {
  state: HealthState;
  reason?: string;
  since?: Date;
}

// ═══════════════════════════════════════════════════════════════════════
// Pluggable validator + batch policy
// ═══════════════════════════════════════════════════════════════════════

export type ValidationResult = { ok: true } | { ok: false; reason: PosterRejection };

export interface MessageValidator {
  validate(msg: DecodedMessage): ValidationResult;
  /**
   * Optional: recover the authenticated signer identity from the
   * message's signature. Used to key the rate limiter on a value the
   * client can't spoof.
   */
  recoverSigner?(msg: DecodedMessage): Address | null;
}

export interface PoolView {
  /** Return pending messages for `tag` in per-tag FIFO order. */
  list(tag: Bytes32): readonly DecodedMessage[];
}

export interface BatchPolicy {
  select(
    tag: Bytes32,
    pool: PoolView,
    blobCapacityBytes: number,
    now: Date
  ): { msgs: DecodedMessage[] } | null;
}

// ═══════════════════════════════════════════════════════════════════════
// Signer seam (KMS/remote-signer lives behind this interface)
// ═══════════════════════════════════════════════════════════════════════

export interface Signer {
  /** viem Account — never exposes the raw private key. */
  account(): Account;
}

// ═══════════════════════════════════════════════════════════════════════
// PosterConfig
// ═══════════════════════════════════════════════════════════════════════

export type PosterLogger = (level: 'info' | 'warn' | 'error', message: string) => void;

export interface RateLimitConfig {
  windowMs: number;
  maxPerWindow: number;
}

export interface BackoffConfig {
  baseMs: number;
  capMs: number;
  degradedAfterAttempts: number;
  unhealthyAfterAttempts: number;
}

export interface PosterConfig {
  allowlistedTags: Bytes32[];
  chainId: number;
  bamCoreAddress: Address;
  signer: Signer;
  validator?: MessageValidator;
  batchPolicy?: BatchPolicy;
  /** Max per-message wire-envelope size in bytes. */
  maxMessageSizeBytes?: number;
  /** Max `contents` (tag prefix + app bytes) size in bytes. */
  maxContentsSizeBytes?: number;
  blobCapacityBytes?: number;
  reorgWindowBlocks?: number;
  rateLimit?: RateLimitConfig;
  backoff?: BackoffConfig;
  store?: BamStore;
  now?: () => Date;
  idlePollMs?: number;
  reorgPollMs?: number;
  logger?: PosterLogger;
}

// ═══════════════════════════════════════════════════════════════════════
// Library surface
// ═══════════════════════════════════════════════════════════════════════

export interface Poster {
  submit(message: Uint8Array, hint?: SubmitHint): Promise<SubmitResult>;
  listPending(query?: PendingQuery): Promise<Pending[]>;
  listSubmittedBatches(query?: SubmittedBatchesQuery): Promise<SubmittedBatch[]>;
  status(): Promise<Status>;
  health(): Promise<Health>;
  start(): Promise<void>;
  stop(): Promise<void>;
}
