/**
 * Multi-segment blob assembly — pure byte arithmetic.
 *
 * Lays out N per-tag payloads into a single EIP-4844 blob at FE-aligned
 * offsets. Each payload occupies `[startFE * 31, endFE * 31)` of the blob's
 * usable bytes; byte 0 of every field element stays 0x00 so the FE value
 * remains less than the BLS12-381 scalar-field modulus.
 *
 * Pure — no Node-only imports; safe to run in browser bundles.
 *
 * @module bam-sdk/blob/multi-segment
 */

import type { Bytes32 } from '../types.js';
import {
  BYTES_PER_BLOB,
  BYTES_PER_FIELD_ELEMENT,
  FIELD_ELEMENTS_PER_BLOB,
  USABLE_BYTES_PER_FIELD_ELEMENT,
} from './constants.js';

export interface MultiSegmentInput {
  contentTag: Bytes32;
  payload: Uint8Array;
}

export interface AssembledSegment {
  contentTag: Bytes32;
  startFE: number;
  endFE: number;
}

export interface AssembledMultiSegmentBlob {
  blob: Uint8Array;
  segments: AssembledSegment[];
}

/**
 * Assemble multiple per-tag payloads into one 4844 blob.
 *
 * Each segment is laid down at the next FE-aligned offset in the blob;
 * `endFE = startFE + ceil(payload.length / 31)`. An empty `segments` list
 * returns an empty blob (`Uint8Array(BYTES_PER_BLOB)` of all zeros) with
 * an empty `segments` array. Throws if the aggregate of all segments'
 * `endFE` would exceed `FIELD_ELEMENTS_PER_BLOB`.
 *
 * Note: this helper does not enforce a minimum payload length. A caller
 * passing a zero-length payload will produce a zero-length segment
 * (`startFE === endFE`); on-chain `declareBlobSegment` rejects that
 * range, so producers MUST drop zero-length segments before assembly.
 */
export function assembleMultiSegmentBlob(
  segments: MultiSegmentInput[]
): AssembledMultiSegmentBlob {
  const blob = new Uint8Array(BYTES_PER_BLOB);
  const result: AssembledSegment[] = [];

  let cursorFE = 0;
  for (const segment of segments) {
    const { contentTag, payload } = segment;
    const segmentFEs = Math.ceil(payload.length / USABLE_BYTES_PER_FIELD_ELEMENT);
    const startFE = cursorFE;
    const endFE = startFE + segmentFEs;

    if (endFE > FIELD_ELEMENTS_PER_BLOB) {
      throw new Error(
        `assembleMultiSegmentBlob: aggregate endFE ${endFE} exceeds ${FIELD_ELEMENTS_PER_BLOB}`
      );
    }

    let srcOffset = 0;
    for (let fe = startFE; fe < endFE; fe++) {
      const feOffset = fe * BYTES_PER_FIELD_ELEMENT;
      const remaining = payload.length - srcOffset;
      const bytesToCopy = remaining > USABLE_BYTES_PER_FIELD_ELEMENT
        ? USABLE_BYTES_PER_FIELD_ELEMENT
        : remaining;
      // Byte 0 of every FE stays 0x00 (Uint8Array starts zero); copy payload to bytes 1..31.
      blob.set(payload.subarray(srcOffset, srcOffset + bytesToCopy), feOffset + 1);
      srcOffset += bytesToCopy;
    }

    result.push({ contentTag, startFE, endFE });
    cursorFE = endFE;
  }

  return { blob, segments: result };
}
