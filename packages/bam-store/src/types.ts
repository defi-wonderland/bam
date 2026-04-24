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
// PosterStore — single durable substrate for pool + dedup + submitted
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
}

export interface PosterStore {
  withTxn<T>(fn: (txn: StoreTxn) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
