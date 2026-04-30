/**
 * Field element / blob layout constants — single source of truth for the SDK.
 *
 * Producer-side (`assembleMultiSegmentBlob`, `createBlob`) and read-side
 * (`extractSegmentBytes`, Reader pipelines) MUST import these constants
 * rather than redeclaring `31` / `32` / `4096` inline; a CI grep gate
 * enforces this for `bam-poster` and `bam-reader`.
 *
 * @module bam-sdk/blob/constants
 */

/** Bytes per EIP-4844 field element. Each FE is 32 bytes wide on the wire. */
export const BYTES_PER_FIELD_ELEMENT = 32;

/**
 * Usable bytes per field element. Byte 0 of every FE is reserved as 0x00 so
 * the FE value remains less than the BLS12-381 scalar-field modulus; the
 * remaining 31 bytes carry payload.
 */
export const USABLE_BYTES_PER_FIELD_ELEMENT = 31;

/** Number of field elements per blob (EIP-4844). */
export const FIELD_ELEMENTS_PER_BLOB = 4096;

/** Total blob size on the wire, in bytes. `131072` (128 KiB). */
export const BYTES_PER_BLOB = FIELD_ELEMENTS_PER_BLOB * BYTES_PER_FIELD_ELEMENT;

/** Total usable payload capacity per blob, in bytes. `126976` (≈ 124 KiB). */
export const USABLE_BYTES_PER_BLOB =
  FIELD_ELEMENTS_PER_BLOB * USABLE_BYTES_PER_FIELD_ELEMENT;
