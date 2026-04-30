import type { Bytes32 } from 'bam-sdk';

import type { Health, HealthState, HealthTagEntry } from '../types.js';

export interface HealthOptions {
  /** Current aggregate health from submission loops (worst of all tags). */
  submissionState: HealthState;
  /** Reason string if non-ok; `undefined` when state is `ok`. */
  reason?: string;
  /** When the current state was entered. */
  since?: Date;
  /** Per-tag submission state, for diagnosis. */
  byTag?: ReadonlyMap<Bytes32, HealthState>;
  /**
   * Aggregator-level fields (006-blob-packing-multi-tag, T023). When
   * present, `readHealth` includes them in the response.
   */
  aggregator?: {
    lastPackedTxHash: Bytes32 | null;
    lastPackedTagCount: number;
    permanentlyStopped: boolean;
    tags: HealthTagEntry[];
  };
}

/**
 * `health()` read surface — qualitative. Returns the current health
 * state + a human-readable reason. Does NOT expose balances, counts,
 * tags, or txs — those live on `status()`.
 */
export function readHealth(opts: HealthOptions): Health {
  const base: Health =
    opts.submissionState === 'ok'
      ? { state: 'ok' }
      : { state: opts.submissionState, reason: opts.reason, since: opts.since };

  if (opts.aggregator) {
    return {
      ...base,
      lastPackedTxHash: opts.aggregator.lastPackedTxHash,
      lastPackedTagCount: opts.aggregator.lastPackedTagCount,
      permanentlyStopped: opts.aggregator.permanentlyStopped,
      tags: opts.aggregator.tags,
    };
  }
  return base;
}
