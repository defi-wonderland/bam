/**
 * Persistence types for the BAM storage substrate.
 *
 * This package owns the durable schema and the transactional caller
 * surface consumed today by the Poster and, in a forthcoming feature,
 * by the Reader.
 */

import type { Address, Bytes32 } from 'bam-sdk';

// ═══════════════════════════════════════════════════════════════════════
// Submitted-batch status + query shapes
// ═══════════════════════════════════════════════════════════════════════

export type SubmittedBatchStatus = 'pending' | 'included' | 'reorged' | 'resubmitted';

export interface SubmittedBatchesQuery {
  contentTag?: Bytes32;
  sinceBlock?: bigint;
  limit?: number;
}

// ═══════════════════════════════════════════════════════════════════════
// BamStore — single durable substrate for pool + dedup + submitted
// ═══════════════════════════════════════════════════════════════════════

export interface StoreTxnPendingRow {
  contentTag: Bytes32;
  sender: Address;
  nonce: bigint;
  contents: Uint8Array;
  signature: Uint8Array;
  messageHash: Bytes32;
  ingestedAt: number;
  ingestSeq: number;
}

/**
 * Per-message snapshot retained in `poster_submitted_batches` so the
 * reorg watcher can re-enqueue messages into the pending pool after
 * inclusion-time pruning.
 */
export interface MessageSnapshot {
  sender: Address;
  nonce: bigint;
  contents: Uint8Array;
  signature: Uint8Array;
  messageHash: Bytes32;
  /** `messageId` is batch-scoped and only meaningful when the parent row's status is `'included'`. */
  messageId: Bytes32 | null;
  originalIngestSeq: number;
}

export interface StoreTxnSubmittedRow {
  txHash: Bytes32;
  contentTag: Bytes32;
  blobVersionedHash: Bytes32;
  batchContentHash: Bytes32;
  blockNumber: number | null;
  status: SubmittedBatchStatus;
  replacedByTxHash: Bytes32 | null;
  submittedAt: number;
  invalidatedAt: number | null;
  messages: MessageSnapshot[];
}

export interface NonceTrackerRow {
  sender: Address;
  lastNonce: bigint;
  lastMessageHash: Bytes32;
}

export interface PendingKey {
  sender: Address;
  nonce: bigint;
}

export interface StoreTxn {
  // ── pending CRUD ─────────────────────────────────────────────────────
  insertPending(row: StoreTxnPendingRow): void | Promise<void>;
  getPendingByKey(
    key: PendingKey
  ): StoreTxnPendingRow | null | Promise<StoreTxnPendingRow | null>;
  listPendingByTag(
    tag: Bytes32,
    limit?: number,
    sinceSeq?: number
  ): StoreTxnPendingRow[] | Promise<StoreTxnPendingRow[]>;
  listPendingAll(
    limit?: number,
    sinceSeq?: number
  ): StoreTxnPendingRow[] | Promise<StoreTxnPendingRow[]>;
  deletePending(keys: PendingKey[]): void | Promise<void>;
  countPendingByTag(tag: Bytes32): number | Promise<number>;
  nextIngestSeq(tag: Bytes32): number | Promise<number>;

  // ── nonce tracker CRUD ───────────────────────────────────────────────
  getNonce(sender: Address): NonceTrackerRow | null | Promise<NonceTrackerRow | null>;
  setNonce(row: NonceTrackerRow): void | Promise<void>;

  // ── submitted-batches CRUD ───────────────────────────────────────────
  insertSubmitted(row: StoreTxnSubmittedRow): void | Promise<void>;
  getSubmittedByTx(
    txHash: Bytes32
  ): StoreTxnSubmittedRow | null | Promise<StoreTxnSubmittedRow | null>;
  listSubmitted(
    query: SubmittedBatchesQuery
  ): StoreTxnSubmittedRow[] | Promise<StoreTxnSubmittedRow[]>;
  updateSubmittedStatus(
    txHash: Bytes32,
    status: SubmittedBatchStatus,
    replacedByTxHash: Bytes32 | null,
    blockNumber: number | null,
    invalidatedAt?: number | null
  ): void | Promise<void>;

  // ── unified-schema lifecycle transitions (T004 — impls land T005–T007) ─
  /** Poster-side: move rows from `pending` to `submitted` and attach a batch ref. */
  markSubmitted(keys: PendingKey[], batchRef: Bytes32): void | Promise<void>;
  /** Reader-side: idempotent upsert of an observed message keyed by (author, nonce). */
  upsertObserved(row: MessageRow): void | Promise<void>;
  /** Reader-side: mark a later-arriving row as a duplicate of an already-confirmed (author, nonce). */
  markDuplicate(messageHash: Bytes32, reason?: string): void | Promise<void>;
  /** Poster-side or Reader-side: mark a submitted/confirmed row as reorged. */
  markReorged(txHash: Bytes32, invalidatedAt: number): void | Promise<void>;

  // ── unified-schema reads ──────────────────────────────────────────────
  listMessages(query: MessagesQuery): MessageRow[] | Promise<MessageRow[]>;
  getByMessageId(messageId: Bytes32): MessageRow | null | Promise<MessageRow | null>;
  getByAuthorNonce(
    author: Address,
    nonce: bigint
  ): MessageRow | null | Promise<MessageRow | null>;

  // ── unified-schema batch CRUD ────────────────────────────────────────
  upsertBatch(row: BatchRow): void | Promise<void>;
  updateBatchStatus(
    txHash: Bytes32,
    status: BatchStatus,
    opts?: {
      blockNumber?: number | null;
      txIndex?: number | null;
      replacedByTxHash?: Bytes32 | null;
      invalidatedAt?: number | null;
    }
  ): void | Promise<void>;
  listBatches(query: BatchesQuery): BatchRow[] | Promise<BatchRow[]>;

  // ── reader cursor ────────────────────────────────────────────────────
  getCursor(chainId: number): ReaderCursorRow | null | Promise<ReaderCursorRow | null>;
  setCursor(row: ReaderCursorRow): void | Promise<void>;
}

export interface BamStore {
  withTxn<T>(fn: (txn: StoreTxn) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

// ═══════════════════════════════════════════════════════════════════════
// Unified-schema row types (T004 — wired through in T005–T007)
// ═══════════════════════════════════════════════════════════════════════

/**
 * First-class lifecycle state per the spec:
 *   pending   — Poster accepted, not yet submitted.
 *   submitted — Poster submitted (tx broadcast); not yet confirmed.
 *   confirmed — Landed on L1 at configured depth.
 *   duplicate — A later-arriving `(author, nonce)` whose original row
 *               was already `confirmed` by a different Poster; the first
 *               row wins and the duplicate is retained but discarded
 *               downstream. Original row is never mutated.
 *   reorged   — A previously-confirmed row whose batch reorged out.
 */
export type MessageStatus = 'pending' | 'submitted' | 'confirmed' | 'duplicate' | 'reorged';

export type BatchStatus = 'pending_tx' | 'confirmed' | 'reorged';

/**
 * Chain-derived ordering coordinate for Reader-observed messages.
 * Reproducible from L1 and instance-independent; no Reader-local
 * counter is introduced for observed rows.
 */
export interface ChainCoord {
  blockNumber: number;
  txIndex: number;
  messageIndexWithinBatch: number;
}

/**
 * Unified message row — source of truth for message payload bytes.
 * The Poster writes `pending`/`submitted`/`reorged`; the Reader writes
 * `confirmed`/`duplicate`. Invalid cross-component transitions are
 * unreachable through the caller surface.
 */
export interface MessageRow {
  /** ERC-8180 messageId. Populated only once the message is part of a confirmed batch. */
  messageId: Bytes32 | null;
  author: Address;
  nonce: bigint;
  contentTag: Bytes32;
  contents: Uint8Array;
  signature: Uint8Array;
  /** ERC-8180 messageHash — keccak256(sender || nonce || contents). Stable pre-batch identifier. */
  messageHash: Bytes32;
  status: MessageStatus;
  /** FK to `batches.tx_hash`. Null until the message is submitted or observed. */
  batchRef: Bytes32 | null;
  /** Poster-side ingest time, ms since epoch. Null on Reader-observed rows. */
  ingestedAt: number | null;
  /** Poster-side per-tag ingest counter. Null on Reader-observed rows. */
  ingestSeq: number | null;
  /** Chain-derived ordering. Populated at confirmation; null otherwise. */
  blockNumber: number | null;
  txIndex: number | null;
  messageIndexWithinBatch: number | null;
}

/**
 * Unified batch row — on-chain metadata only. No duplicated message
 * payloads. Carries a `chainId` so a future multi-chain Reader operates
 * without a schema change.
 */
export interface BatchRow {
  txHash: Bytes32;
  chainId: number;
  contentTag: Bytes32;
  blobVersionedHash: Bytes32;
  /** ERC-8180 batch contentHash. */
  batchContentHash: Bytes32;
  blockNumber: number | null;
  txIndex: number | null;
  status: BatchStatus;
  replacedByTxHash: Bytes32 | null;
  submittedAt: number | null;
  invalidatedAt: number | null;
}

/**
 * Reader's event-scan resume point, singleton per chain. Unused until
 * `004-reader`; the schema carries it now so the Reader plugs in
 * without a migration.
 */
export interface ReaderCursorRow {
  chainId: number;
  lastBlockNumber: number;
  lastTxIndex: number;
  updatedAt: number;
}

export interface MessagesQuery {
  contentTag?: Bytes32;
  author?: Address;
  status?: MessageStatus;
  /** Restrict to messages attached to a specific batch. */
  batchRef?: Bytes32;
  sinceBlock?: bigint;
  cursor?: ChainCoord;
  limit?: number;
}

export interface BatchesQuery {
  contentTag?: Bytes32;
  chainId?: number;
  status?: BatchStatus;
  sinceBlock?: bigint;
  limit?: number;
}

