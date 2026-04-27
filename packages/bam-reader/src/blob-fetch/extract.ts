/**
 * Field-element unpadding for EIP-4844 blob bytes.
 *
 * A blob is 4096 32-byte field elements. Each FE's byte 0 is reserved
 * (kept ≤ 0x73 so the 32-byte word stays under the BLS scalar field
 * modulus); the wire format reserves it as 0x00 and packs 31 usable
 * bytes per FE. Strip byte 0 of each FE and concatenate to recover the
 * payload bytes the writer fed in.
 */

export const FIELD_ELEMENTS_PER_BLOB = 4096;
export const BYTES_PER_FIELD_ELEMENT = 32;
export const USABLE_BYTES_PER_FIELD_ELEMENT = 31;
export const USABLE_BYTES_PER_BLOB =
  FIELD_ELEMENTS_PER_BLOB * USABLE_BYTES_PER_FIELD_ELEMENT;

export function extractUsableBytes(blob: Uint8Array): Uint8Array {
  if (blob.length !== FIELD_ELEMENTS_PER_BLOB * BYTES_PER_FIELD_ELEMENT) {
    throw new RangeError(
      `expected ${FIELD_ELEMENTS_PER_BLOB * BYTES_PER_FIELD_ELEMENT}-byte blob, got ${blob.length}`
    );
  }
  const result = new Uint8Array(USABLE_BYTES_PER_BLOB);
  for (let fe = 0; fe < FIELD_ELEMENTS_PER_BLOB; fe++) {
    const src = fe * BYTES_PER_FIELD_ELEMENT + 1;
    const dst = fe * USABLE_BYTES_PER_FIELD_ELEMENT;
    result.set(
      blob.subarray(src, src + USABLE_BYTES_PER_FIELD_ELEMENT),
      dst
    );
  }
  return result;
}
