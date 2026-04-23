/**
 * Public types and interfaces for the BAM Poster library.
 *
 * This file is declaration-only. Runtime logic lives in the modules that
 * implement these interfaces (`src/ingest/`, `src/pool/`, `src/policy/`,
 * `src/signer/`, `src/submission/`, `src/surfaces/`).
 */

import type { Address, Bytes32, SignedMessage } from 'bam-sdk';
import type { Account } from 'viem';

import type { PosterRejection } from './errors.js';

// ═══════════════════════════════════════════════════════════════════════
// Submit API
// ═══════════════════════════════════════════════════════════════════════

/**
 * Optional transport-supplied hint. The hint is **advisory only** — the
 * signed message payload is the authoritative source for every ingest
 * decision (per ERC-8180 contentTag uniformity).
 */
export interface SubmitHint {
  contentTag?: Bytes32;
}

export type SubmitResult =
  | { accepted: true; messageId: Bytes32 }
  | { accepted: false; reason: PosterRejection };

// ═══════════════════════════════════════════════════════════════════════
// Decoded message (post-validator, pre-pool representation)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Canonical internal representation of a signed, well-formed message
 * that has passed size + structural decoding.
 *
 * `nonce` is `bigint` in the Poster's internal model so the pool and
 * dedup index can forward-compat to uint64 if ERC-8180 widens the
 * nonce field. The SDK's v1 wire format caps `nonce` at 65535; the
 * store codec enforces the current width on insert.
 */
export interface DecodedMessage {
  /** Signed author (recovered address if recovered, or asserted + checked). */
  author: Address;
  /** Per-sender sequential counter. */
  nonce: bigint;
  /** UTF-8 message content. */
  content: string;
  /** Unix epoch seconds as signed over. */
  timestamp: number;
  /** Authoritative content tag bound in the signed payload. */
  contentTag: Bytes32;
  /** Raw signature bytes (65-byte ECDSA in v1). */
  signature: Uint8Array;
  /** Canonical id computed via `bam-sdk.computeMessageId`. */
  messageId: Bytes32;
  /** Original raw bytes as presented to the ingest boundary (size-bound + dedup). */
  raw: Uint8Array;
}

// ═══════════════════════════════════════════════════════════════════════
// Pool read surface
// ═══════════════════════════════════════════════════════════════════════

export interface Pending {
  messageId: Bytes32;
  contentTag: Bytes32;
  author: Address;
  nonce: bigint;
  content: string;
  timestamp: number;
  signature: Uint8Array;
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

export type SubmittedBatchStatus = 'pending' | 'included' | 'reorged' | 'resubmitted';

export interface SubmittedBatch {
  txHash: Bytes32;
  contentTag: Bytes32;
  blobVersionedHash: Bytes32;
  blockNumber: number | null;
  status: SubmittedBatchStatus;
  replacedByTxHash: Bytes32 | null;
  submittedAt: number;
  messageIds: Bytes32[];
}

export interface SubmittedBatchesQuery {
  contentTag?: Bytes32;
  sinceBlock?: bigint;
  limit?: number;
}

// ═══════════════════════════════════════════════════════════════════════
// Status + health (disjoint surfaces — see plan C-9)
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
// PosterStore — single durable substrate for pool + dedup + submitted
// ═══════════════════════════════════════════════════════════════════════

export interface StoreTxnPendingRow {
  messageId: Bytes32;
  contentTag: Bytes32;
  author: Address;
  nonce: bigint;
  /** Author-signed timestamp (unix seconds) — needed to rebuild SignedMessage for batch encoding. */
  timestamp: number;
  content: Uint8Array;
  signature: Uint8Array;
  ingestedAt: number;
  ingestSeq: number;
}

/**
 * Per-message snapshot retained in `poster_submitted_batches` so the
 * reorg watcher can re-enqueue messages into the pending pool after
 * the original rows were pruned on inclusion.
 */
export interface MessageSnapshot {
  messageId: Bytes32;
  author: Address;
  nonce: bigint;
  timestamp: number;
  content: string;
  signature: Uint8Array;
  originalIngestSeq: number;
}

export interface StoreTxnSubmittedRow {
  txHash: Bytes32;
  contentTag: Bytes32;
  blobVersionedHash: Bytes32;
  blockNumber: number | null;
  status: SubmittedBatchStatus;
  replacedByTxHash: Bytes32 | null;
  submittedAt: number;
  messageIds: Bytes32[];
  messages: MessageSnapshot[];
}

export interface NonceTrackerRow {
  author: Address;
  lastNonce: bigint;
  lastMessageId: Bytes32;
}

export interface StoreTxn {
  // ── pending CRUD ─────────────────────────────────────────────────────
  insertPending(row: StoreTxnPendingRow): void | Promise<void>;
  getPendingByMessageId(messageId: Bytes32): StoreTxnPendingRow | null | Promise<StoreTxnPendingRow | null>;
  listPendingByTag(tag: Bytes32, limit?: number, sinceSeq?: number): StoreTxnPendingRow[] | Promise<StoreTxnPendingRow[]>;
  listPendingAll(limit?: number, sinceSeq?: number): StoreTxnPendingRow[] | Promise<StoreTxnPendingRow[]>;
  deletePending(messageIds: Bytes32[]): void | Promise<void>;
  countPendingByTag(tag: Bytes32): number | Promise<number>;
  nextIngestSeq(tag: Bytes32): number | Promise<number>;

  // ── nonce tracker CRUD ───────────────────────────────────────────────
  getNonce(author: Address): NonceTrackerRow | null | Promise<NonceTrackerRow | null>;
  setNonce(row: NonceTrackerRow): void | Promise<void>;

  // ── submitted-batches CRUD ───────────────────────────────────────────
  insertSubmitted(row: StoreTxnSubmittedRow): void | Promise<void>;
  getSubmittedByTx(txHash: Bytes32): StoreTxnSubmittedRow | null | Promise<StoreTxnSubmittedRow | null>;
  listSubmitted(query: SubmittedBatchesQuery): StoreTxnSubmittedRow[] | Promise<StoreTxnSubmittedRow[]>;
  updateSubmittedStatus(
    txHash: Bytes32,
    status: SubmittedBatchStatus,
    replacedByTxHash: Bytes32 | null,
    blockNumber: number | null
  ): void | Promise<void>;
}

export interface PosterStore {
  withTxn<T>(fn: (txn: StoreTxn) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

// ═══════════════════════════════════════════════════════════════════════
// PosterConfig
// ═══════════════════════════════════════════════════════════════════════

export interface RateLimitConfig {
  /** Sliding-window width in milliseconds. */
  windowMs: number;
  /** Maximum accepted submits per signer address per window. */
  maxPerWindow: number;
}

export interface BackoffConfig {
  baseMs: number;
  capMs: number;
  /** Attempts before health flips from `ok` to `degraded`. */
  degradedAfterAttempts: number;
  /** Attempts before health flips from `degraded` to `unhealthy`. */
  unhealthyAfterAttempts: number;
}

export interface PosterConfig {
  /** Required — operator's tag allowlist. */
  allowlistedTags: Bytes32[];
  /** Required — expected chain-ID for startup reconciliation. */
  chainId: number;
  /** Required — BAM Core contract address. */
  bamCoreAddress: Address;
  /** Required — the signer that owns the Poster's wallet. */
  signer: Signer;
  /** Optional — custom validator; default is ECDSA verify via `bam-sdk`. */
  validator?: MessageValidator;
  /** Optional — custom batch policy; default is per-tag FIFO size/age. */
  batchPolicy?: BatchPolicy;
  /** Max per-message size in bytes (default: aligned with BAM blob capacity). */
  maxMessageSizeBytes?: number;
  /** Blob capacity exposed to the default batch policy (default: 126 KiB). */
  blobCapacityBytes?: number;
  /** Reorg re-enqueue window, in blocks. Clamped `[4, 128]`; default 32. */
  reorgWindowBlocks?: number;
  /** Rate-limit tuning — see `RateLimitConfig`. */
  rateLimit?: RateLimitConfig;
  /** Submission backoff tuning — see `BackoffConfig`. */
  backoff?: BackoffConfig;
  /** Override the pool store. Defaults to in-memory for tests, DB-backed in prod. */
  store?: PosterStore;
  /** Wall-clock source; default `() => new Date()`. Exposed for tests. */
  now?: () => Date;
  /** Decoder address passed through to `registerBlobBatch`. Default `zeroAddress`. */
  decoderAddress?: Address;
  /** Signature registry address passed through to `registerBlobBatch`. Default `zeroAddress`. */
  signatureRegistryAddress?: Address;
  /** Idle-poll delay for the per-tag submission workers, in ms. Default 1000. */
  idlePollMs?: number;
  /** Reorg-watcher tick interval, in ms. Default 12000 (L1 block time). */
  reorgPollMs?: number;
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
  /** Starts per-tag submission loops + reorg watcher. */
  start(): Promise<void>;
  /** Graceful shutdown. */
  stop(): Promise<void>;
}

// Re-export helpful SDK types so consumers don't need to dual-import.
export type { SignedMessage };
