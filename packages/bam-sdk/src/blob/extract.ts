/**
 * Range-aware extraction of a per-tag segment from a 4844 blob.
 *
 * Mirrors the producer-side layout in `assembleMultiSegmentBlob`: each
 * field element reserves byte 0 for padding (0x00); the remaining 31
 * usable bytes carry payload. Given `(startFE, endFE)`, returns the
 * concatenation of bytes 1..31 of every FE in `[startFE, endFE)`.
 *
 * Pure — no Node-only imports; safe to run in browser bundles.
 *
 * @module bam-sdk/blob/extract
 */

import {
  BYTES_PER_FIELD_ELEMENT,
  FIELD_ELEMENTS_PER_BLOB,
  USABLE_BYTES_PER_FIELD_ELEMENT,
} from './constants.js';

/**
 * Extract the usable bytes of a per-tag segment.
 *
 * Throws `RangeError` for any of the following:
 * - non-integer or non-finite `startFE` / `endFE`
 * - `startFE < 0`
 * - `endFE > FIELD_ELEMENTS_PER_BLOB`
 * - `startFE >= endFE`
 *
 * Returns a freshly-allocated `Uint8Array` of length
 * `(endFE - startFE) * 31`.
 */
export function extractSegmentBytes(
  blob: Uint8Array,
  startFE: number,
  endFE: number
): Uint8Array {
  if (!Number.isInteger(startFE) || !Number.isInteger(endFE)) {
    throw new RangeError(
      `extractSegmentBytes: startFE and endFE must be integers (got ${startFE}, ${endFE})`
    );
  }
  if (startFE < 0) {
    throw new RangeError(`extractSegmentBytes: startFE must be >= 0 (got ${startFE})`);
  }
  if (endFE > FIELD_ELEMENTS_PER_BLOB) {
    throw new RangeError(
      `extractSegmentBytes: endFE must be <= ${FIELD_ELEMENTS_PER_BLOB} (got ${endFE})`
    );
  }
  if (startFE >= endFE) {
    throw new RangeError(
      `extractSegmentBytes: startFE must be < endFE (got ${startFE}, ${endFE})`
    );
  }

  const result = new Uint8Array((endFE - startFE) * USABLE_BYTES_PER_FIELD_ELEMENT);
  let dst = 0;
  for (let fe = startFE; fe < endFE; fe++) {
    const feOffset = fe * BYTES_PER_FIELD_ELEMENT;
    // Skip byte 0 (padding); copy bytes 1..31.
    result.set(
      blob.subarray(feOffset + 1, feOffset + 1 + USABLE_BYTES_PER_FIELD_ELEMENT),
      dst
    );
    dst += USABLE_BYTES_PER_FIELD_ELEMENT;
  }

  return result;
}
