import type { Bytes32 } from 'bam-sdk';

import type { Health, HealthState } from '../types.js';

export interface HealthOptions {
  /** Current aggregate health from submission loops (worst of all tags). */
  submissionState: HealthState;
  /** Reason string if non-ok; `undefined` when state is `ok`. */
  reason?: string;
  /** When the current state was entered. */
  since?: Date;
  /** Per-tag submission state, for diagnosis. */
  byTag?: ReadonlyMap<Bytes32, HealthState>;
}

/**
 * `health()` read surface — qualitative (plan §C-9). Returns the
 * current health state + a human-readable reason. Does NOT expose
 * balances, counts, tags, or txs — those live on `status()`.
 */
export function readHealth(opts: HealthOptions): Health {
  if (opts.submissionState === 'ok') {
    return { state: 'ok' };
  }
  return {
    state: opts.submissionState,
    reason: opts.reason,
    since: opts.since,
  };
}
