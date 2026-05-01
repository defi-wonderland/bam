import type { Address } from 'bam-sdk';

import type { BamStore } from '../types.js';

/**
 * Per-sender next-nonce read surface. Returns `lastNonce + 1` from the
 * nonce tracker, or `0n` if the sender has never had a message accepted.
 *
 * The nonce tracker is updated atomically inside the same `withTxn` that
 * inserts the pending row (see `ingest/pipeline.ts`), so the value here
 * is the same one the monotonicity check (`ingest/monotonicity.ts`) uses
 * to reject `stale_nonce`. That makes this endpoint authoritative across
 * every contentTag the Poster serves — callers no longer need to walk
 * pending + confirmed per-tag to reconstruct it.
 */
export async function getNextNonce(
  store: BamStore,
  sender: Address
): Promise<bigint> {
  const row = await store.withTxn((txn) => txn.getNonce(sender));
  if (row === null) return 0n;
  return row.lastNonce + 1n;
}
