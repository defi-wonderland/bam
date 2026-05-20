/**
 * Public configuration + observability types for `bam-indexer`.
 *
 * The factory in `factory.ts` returns an `Indexer` whose state lives
 * entirely in Postgres — there is no in-memory cursor cache, so two
 * processes pointed at the same Postgres+handler-set will converge
 * (last-writer-wins per row, with idempotent upserts).
 */

import type { Bytes32 } from 'bam-sdk';

export interface IndexerConfig {
  /** Required; cross-checked against `bam-store`'s tracked chainId. */
  chainId: number;
  /** Read-only DSN for `bam-store` (messages + batches). */
  sourceDbUrl: string;
  /** Read/write DSN for indexer's own schemas + per-handler schemas. */
  writeDbUrl: string;
  /** Tick cadence in ms (default 5000). */
  pollMs: number;
  /** Max rows pulled per handler per tick (default 200). */
  batchSize: number;
  /** Default 127.0.0.1 per red-team analog of Reader C-1. */
  httpBind: string;
  /** Default 8789. */
  httpPort: number;
  /**
   * `contentTag` for the bam-twitter post-reply handler instance.
   * keccak256(utf8("bam-twitter.v1")) on production, but operators
   * point at staging / fork tags by overriding the env var.
   */
  twitterTag: Bytes32;
}

export type IndexerEventName =
  | 'tick_start'
  | 'tick_done'
  | 'handler_projected'
  | 'handler_skipped_decode'
  | 'run_in_txn_handler_skipped_conflict'
  | 'reorg_one_handler_skipped_conflict'
  | 'handler_reorged'
  | 'version_superseded'
  | 'enricher_error'
  | 'source_error'
  | 'http_started';

export interface IndexerEvent {
  event: IndexerEventName;
  handler?: string;
  contentTag?: Bytes32;
  detail?: Record<string, unknown>;
  ts: number;
}

export type IndexerLogger = (event: IndexerEvent) => void;

export interface HandlerCounters {
  projected: number;
  skippedDecode: number;
  skippedConflict: number;
  reorged: number;
}

export interface IndexerCounters {
  byHandler: Record<string, HandlerCounters>;
}

export function emptyHandlerCounters(): HandlerCounters {
  return { projected: 0, skippedDecode: 0, skippedConflict: 0, reorged: 0 };
}
