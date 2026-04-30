/**
 * Range-validation chokepoint for the `(startFE, endFE)` carried on a
 * `BlobBatchRegistered` event after the segment-event join.
 *
 * Every Reader code path that consumes a joined event MUST pass
 * `(startFE, endFE)` through this function before any byte slice or
 * store write. Rejected events get logged + skipped; the Reader does
 * not throw past this chokepoint.
 *
 * Invariant: `0 <= startFE < endFE <= FIELD_ELEMENTS_PER_BLOB`, both
 * non-negative integers. The on-chain ABI is `uint16`, but the
 * post-decode JS values are arbitrary numbers, so we also reject
 * non-finite and non-integer values as defense-in-depth against a
 * misbehaving log decoder. The `endFE > 4096` check subsumes any
 * wider ABI bound; rejection reasons are stable strings so log lines
 * and counters are dedup-friendly.
 */

import { FIELD_ELEMENTS_PER_BLOB } from 'bam-sdk';

export type RangeValidationResult =
  | { ok: true }
  | { ok: false; reason: string };

export function validateSegmentRange(
  startFE: number,
  endFE: number
): RangeValidationResult {
  if (!Number.isFinite(startFE) || !Number.isFinite(endFE)) {
    return { ok: false, reason: 'not-finite' };
  }
  if (!Number.isInteger(startFE) || !Number.isInteger(endFE)) {
    return { ok: false, reason: 'not-integer' };
  }
  if (startFE < 0 || endFE < 0) {
    return { ok: false, reason: 'negative' };
  }
  if (endFE > FIELD_ELEMENTS_PER_BLOB) {
    return { ok: false, reason: 'endFE-exceeds-blob' };
  }
  if (startFE >= endFE) {
    return { ok: false, reason: 'inverted-or-zero-length' };
  }
  return { ok: true };
}
