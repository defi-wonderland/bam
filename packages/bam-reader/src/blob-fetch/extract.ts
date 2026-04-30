/**
 * Field-element unpadding for EIP-4844 blob bytes.
 *
 * A blob is 4096 32-byte field elements. Each FE's byte 0 is reserved
 * (kept ≤ 0x73 so the 32-byte word stays under the BLS scalar field
 * modulus); the wire format reserves it as 0x00 and packs 31 usable
 * bytes per FE. Strip byte 0 of each FE and concatenate to recover the
 * payload bytes the writer fed in.
 *
 * The constants and the range-aware extract helper live in `bam-sdk`
 * (the single source of truth — 006-blob-packing-multi-tag, C-8); this
 * module re-exports them so existing import paths keep working.
 */

import {
  BYTES_PER_BLOB,
  BYTES_PER_FIELD_ELEMENT as SDK_BYTES_PER_FIELD_ELEMENT,
  FIELD_ELEMENTS_PER_BLOB as SDK_FIELD_ELEMENTS_PER_BLOB,
  USABLE_BYTES_PER_BLOB as SDK_USABLE_BYTES_PER_BLOB,
  USABLE_BYTES_PER_FIELD_ELEMENT as SDK_USABLE_BYTES_PER_FIELD_ELEMENT,
  extractSegmentBytes,
} from 'bam-sdk';

export const FIELD_ELEMENTS_PER_BLOB = SDK_FIELD_ELEMENTS_PER_BLOB;
export const BYTES_PER_FIELD_ELEMENT = SDK_BYTES_PER_FIELD_ELEMENT;
export const USABLE_BYTES_PER_FIELD_ELEMENT = SDK_USABLE_BYTES_PER_FIELD_ELEMENT;
export const USABLE_BYTES_PER_BLOB = SDK_USABLE_BYTES_PER_BLOB;

export { extractSegmentBytes };

/**
 * Whole-blob convenience that delegates to the SDK's range-aware
 * `extractSegmentBytes(blob, 0, FIELD_ELEMENTS_PER_BLOB)`.
 *
 * Kept for callers that haven't been migrated to range-aware extract;
 * range-aware paths (006) use `extractSegmentBytes` directly with the
 * tight per-tag `(startFE, endFE)` from the validated event.
 */
export function extractUsableBytes(blob: Uint8Array): Uint8Array {
  if (blob.length !== BYTES_PER_BLOB) {
    throw new RangeError(`expected ${BYTES_PER_BLOB}-byte blob, got ${blob.length}`);
  }
  return extractSegmentBytes(blob, 0, FIELD_ELEMENTS_PER_BLOB);
}
