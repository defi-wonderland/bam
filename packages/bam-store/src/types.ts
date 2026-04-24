/**
 * Persistence types for the BAM storage substrate.
 *
 * This package owns the durable schema and the transactional caller
 * surface consumed today by the Poster and, in a forthcoming feature,
 * by the Reader.
 */

import type { Address, Bytes32 } from 'bam-sdk';

// ═══════════════════════════════════════════════════════════════════════
// BamStore — single durable substrate for pool + dedup + confirmed
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
  insertPending(row: StoreTxnPendingRow): Promise<void>;
  getPendingByKey(key: PendingKey): Promise<StoreTxnPendingRow | null>;
  listPendingByTag(
    tag: Bytes32,
    limit?: number,
    sinceSeq?: number
  ): Promise<StoreTxnPendingRow[]>;
  listPendingAll(limit?: number, sinceSeq?: number): Promise<StoreTxnPendingRow[]>;
  countPendingByTag(tag: Bytes32): Promise<number>;
  nextIngestSeq(tag: Bytes32): Promise<number>;

  // ── nonce tracker CRUD ───────────────────────────────────────────────
  getNonce(sender: Address): Promise<NonceTrackerRow | null>;
  setNonce(row: NonceTrackerRow): Promise<void>;

  // ── unified-schema lifecycle transitions ────────────────────────────
  /**
   * Poster-side: move rows from `pending` to `submitted` and attach a batch ref.
   * Used by callers whose `buildAndSubmit` returns before chain inclusion (the
   * Poster's current `buildAndSubmit` blocks on the receipt and goes
   * pending → confirmed directly, but the substrate keeps `submitted` as a
   * first-class state for an async-receipt variant).
   */
  markSubmitted(keys: PendingKey[], batchRef: Bytes32): Promise<void>;
  /** Reader-side: idempotent upsert of an observed message keyed by (author, nonce). */
  upsertObserved(row: MessageRow): Promise<void>;
  /** Poster-side or Reader-side: mark a submitted/confirmed row as reorged. */
  markReorged(txHash: Bytes32, invalidatedAt: number): Promise<void>;

  // ── unified-schema reads ──────────────────────────────────────────────
  listMessages(query: MessagesQuery): Promise<MessageRow[]>;
  getByMessageId(messageId: Bytes32): Promise<MessageRow | null>;
  getByAuthorNonce(author: Address, nonce: bigint): Promise<MessageRow | null>;

  // ── unified-schema batch CRUD ────────────────────────────────────────
  /**
   * Insert or refresh a batch row. The first writer's `messageSnapshot` is
   * preserved across subsequent calls (a Reader observing a Poster-written
   * batch with an empty snapshot will not clobber the Poster's keys).
   * `submittedAt` and `replacedByTxHash` are similarly COALESCEd so a
   * second writer's nulls don't overwrite the first writer's values.
   */
  upsertBatch(row: BatchRow): Promise<void>;
  updateBatchStatus(
    txHash: Bytes32,
    status: BatchStatus,
    opts?: {
      blockNumber?: number | null;
      txIndex?: number | null;
      replacedByTxHash?: Bytes32 | null;
      invalidatedAt?: number | null;
    }
  ): Promise<void>;
  listBatches(query: BatchesQuery): Promise<BatchRow[]>;

  // ── reader cursor ────────────────────────────────────────────────────
  getCursor(chainId: number): Promise<ReaderCursorRow | null>;
  setCursor(row: ReaderCursorRow): Promise<void>;
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
 *   reorged   — A previously-confirmed row whose batch reorged out.
 *
 * The spec's "nonce-replay-across-batchers" duplicate flow is not a
 * distinct lifecycle state. Today the substrate rejects a different-bytes
 * arrival at the same `(author, nonce)`; first-confirmed wins and the
 * later arrival has nowhere to land. The Reader (004) will introduce a
 * proper duplicate sink (separate table or alternate key) for that path.
 */
export type MessageStatus = 'pending' | 'submitted' | 'confirmed' | 'reorged';

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
 * Per-message entry in a batch's snapshot — captures the batch-scoped
 * attributes (messageId, position) that don't survive on the messages
 * table once a message is reorged-and-resubmitted into a different
 * batch. Stored on the batch row, immutable after first write.
 */
export interface BatchMessageSnapshotEntry {
  author: Address;
  nonce: bigint;
  /** ERC-8180 batch-scoped messageId, computed at confirmation. */
  messageId: Bytes32;
  /** Position within the batch's encoded message list. */
  messageIndexWithinBatch: number;
  /** ERC-8180 messageHash — stable identity, useful for overlap checks. */
  messageHash: Bytes32;
}

/**
 * Unified batch row — on-chain metadata + a frozen snapshot of which
 * messages were in this batch at confirmation time. The snapshot
 * preserves the batch → messages association across subsequent message
 * mutations (reorg + re-enqueue + resubmit), which a single
 * `messages.batch_ref` column cannot represent. Carries a `chainId` so
 * a future multi-chain Reader operates without a schema change.
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
  /**
   * Frozen snapshot of which messages were in this batch at confirmation.
   * Empty array allowed (e.g. a Reader has observed the batch but not yet
   * decoded it). Adapters preserve a non-empty snapshot across upserts —
   * a later writer's empty snapshot does not clobber the original.
   */
  messageSnapshot: BatchMessageSnapshotEntry[];
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

