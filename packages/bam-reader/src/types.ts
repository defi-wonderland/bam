/**
 * Public types for the BAM Reader.
 *
 * The Reader is wholly Node-only: it speaks JSON-RPC to an L1 endpoint,
 * HTTP to a beacon API and (optionally) Blobscan, and persists into a
 * shared `bam-store` substrate. None of these surfaces are browser-safe.
 */

import type { Address, Bytes32 } from 'bam-sdk';

// ═══════════════════════════════════════════════════════════════════════
// ReaderConfig — caller-supplied wiring.
// ═══════════════════════════════════════════════════════════════════════

/**
 * Reader runtime configuration. Mirrors the env-var surface documented in
 * the plan; the env loader (T017) parses environment into this shape and
 * the factory (T018) consumes it directly.
 */
export interface ReaderConfig {
  chainId: number;
  rpcUrl: string;
  bamCoreAddress: Address;
  /** Optional beacon API base URL. Primary blob source when set. */
  beaconUrl?: string;
  /** Optional Blobscan base URL. Fallback blob source when set. */
  blobscanUrl?: string;
  /**
   * Optional content-tag allowlist. When present, the discovery scanner
   * filters `BlobBatchRegistered` events by this set; absent ⇒ all tags.
   */
  contentTags?: Bytes32[];
  /**
   * How many blocks behind head the live-tail loop runs. Inherits the
   * Poster's default of 32; clamped at construction.
   */
  reorgWindowBlocks: number;
  /** `bam-store` connection string (sqlite:..., postgres:..., memory:). */
  dbUrl: string;
  /** HTTP server bind address. Default `127.0.0.1` per red-team C-1. */
  httpBind: string;
  httpPort: number;
  /** Bound for non-zero decode/verify `eth_call` gas. */
  ethCallGasCap: bigint;
  /** Bound for non-zero decode/verify `eth_call` wallclock timeout. */
  ethCallTimeoutMs: number;
}

// ═══════════════════════════════════════════════════════════════════════
// ReaderCounters — exported via /health.
// ═══════════════════════════════════════════════════════════════════════

/**
 * Counter shape exposed via `/health`. Updated by the loop as it
 * processes batches.
 */
export interface ReaderCounters {
  /** Messages that landed as `confirmed`. */
  decoded: number;
  /** Batches whose decode failed (structurally or via dispatch bound). */
  skippedDecode: number;
  /** Messages whose verify dispatch returned false / hit cap / timed out. */
  skippedVerify: number;
  /** Conflicting `(author, nonce)` rejections from the substrate. */
  skippedConflict: number;
  /** Batches whose blob bytes could not be reached (permanent classification). */
  undecodable: number;
}

// ═══════════════════════════════════════════════════════════════════════
// ReaderEvent — discriminated union for structured logs.
// ═══════════════════════════════════════════════════════════════════════

export type ReaderEvent =
  | { kind: 'batch_observed'; txHash: Bytes32; blockNumber: number; contentTag: Bytes32 }
  | { kind: 'batch_decoded'; txHash: Bytes32; messageCount: number }
  | { kind: 'batch_decode_failed'; txHash: Bytes32; error: string }
  | { kind: 'message_verified'; txHash: Bytes32; messageHash: Bytes32 }
  | {
      kind: 'message_verify_skipped';
      txHash: Bytes32;
      messageHash: Bytes32;
      cause: 'invalid' | 'gas_cap' | 'timeout' | 'revert';
    }
  | {
      kind: 'message_conflict';
      txHash: Bytes32;
      messageHash: Bytes32;
      author: Address;
      nonce: bigint;
    }
  | {
      kind: 'blob_unreachable';
      txHash: Bytes32;
      versionedHash: Bytes32;
      classification: 'permanent' | 'transient';
    }
  | {
      kind: 'blob_source_lied';
      versionedHash: Bytes32;
      source: 'beacon' | 'blobscan';
    }
  | { kind: 'cursor_advanced'; chainId: number; blockNumber: number }
  | { kind: 'reorg_detected'; txHash: Bytes32 }
  | { kind: 'live_tail_tick_failed'; error: string };
