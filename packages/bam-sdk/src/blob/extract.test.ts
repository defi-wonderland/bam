import { describe, expect, it } from 'vitest';
import {
  BYTES_PER_BLOB,
  FIELD_ELEMENTS_PER_BLOB,
  USABLE_BYTES_PER_FIELD_ELEMENT,
} from './constants.js';
import { extractSegmentBytes } from './extract.js';
import { assembleMultiSegmentBlob } from './multi-segment.js';
import type { Bytes32 } from '../types.js';

const TAG_A: Bytes32 = '0x' + '11'.repeat(32) as Bytes32;
const TAG_B: Bytes32 = '0x' + '22'.repeat(32) as Bytes32;

function payload(len: number, fillByte: number): Uint8Array {
  const buf = new Uint8Array(len);
  buf.fill(fillByte);
  return buf;
}

describe('extractSegmentBytes', () => {
  it('returns 31 bytes from a single-FE segment at boundary [0, 1)', () => {
    const blob = new Uint8Array(BYTES_PER_BLOB);
    // Set bytes 1..31 of FE 0 to 0xab; byte 0 is padding.
    for (let i = 1; i <= USABLE_BYTES_PER_FIELD_ELEMENT; i++) blob[i] = 0xab;

    const bytes = extractSegmentBytes(blob, 0, 1);
    expect(bytes).toHaveLength(USABLE_BYTES_PER_FIELD_ELEMENT);
    expect(bytes.every((b) => b === 0xab)).toBe(true);
  });

  it('returns the last FE only at boundary [4095, 4096)', () => {
    const blob = new Uint8Array(BYTES_PER_BLOB);
    const lastFEOffset = (FIELD_ELEMENTS_PER_BLOB - 1) * 32;
    for (let i = 1; i <= USABLE_BYTES_PER_FIELD_ELEMENT; i++) blob[lastFEOffset + i] = 0xcd;

    const bytes = extractSegmentBytes(blob, FIELD_ELEMENTS_PER_BLOB - 1, FIELD_ELEMENTS_PER_BLOB);
    expect(bytes).toHaveLength(USABLE_BYTES_PER_FIELD_ELEMENT);
    expect(bytes.every((b) => b === 0xcd)).toBe(true);
  });

  it('round-trips: assembleMultiSegmentBlob → extractSegmentBytes returns padded payload', () => {
    const lenA = USABLE_BYTES_PER_FIELD_ELEMENT * 2 - 5; // not a 31-multiple
    const lenB = USABLE_BYTES_PER_FIELD_ELEMENT * 3;
    const a = payload(lenA, 0xaa);
    const b = payload(lenB, 0xbb);

    const { blob, segments } = assembleMultiSegmentBlob([
      { contentTag: TAG_A, payload: a },
      { contentTag: TAG_B, payload: b },
    ]);

    const aBytes = extractSegmentBytes(blob, segments[0]!.startFE, segments[0]!.endFE);
    const bBytes = extractSegmentBytes(blob, segments[1]!.startFE, segments[1]!.endFE);

    // Payload A occupies 2 FEs (62 bytes capacity); first 57 bytes are 0xaa, rest is zero padding.
    expect(aBytes).toHaveLength(USABLE_BYTES_PER_FIELD_ELEMENT * 2);
    expect(aBytes.subarray(0, lenA).every((byte) => byte === 0xaa)).toBe(true);
    expect(aBytes.subarray(lenA).every((byte) => byte === 0x00)).toBe(true);

    // Payload B fits exactly in 3 FEs.
    expect(bBytes).toHaveLength(USABLE_BYTES_PER_FIELD_ELEMENT * 3);
    expect(bBytes.every((byte) => byte === 0xbb)).toBe(true);
  });

  it('throws RangeError on startFE >= endFE', () => {
    const blob = new Uint8Array(BYTES_PER_BLOB);
    expect(() => extractSegmentBytes(blob, 5, 5)).toThrow(RangeError);
    expect(() => extractSegmentBytes(blob, 10, 5)).toThrow(RangeError);
  });

  it('throws RangeError on endFE > FIELD_ELEMENTS_PER_BLOB', () => {
    const blob = new Uint8Array(BYTES_PER_BLOB);
    expect(() => extractSegmentBytes(blob, 0, FIELD_ELEMENTS_PER_BLOB + 1)).toThrow(RangeError);
  });

  it('throws RangeError on startFE < 0', () => {
    const blob = new Uint8Array(BYTES_PER_BLOB);
    expect(() => extractSegmentBytes(blob, -1, 4)).toThrow(RangeError);
  });

  it('throws RangeError on non-integer arguments', () => {
    const blob = new Uint8Array(BYTES_PER_BLOB);
    expect(() => extractSegmentBytes(blob, 0.5, 1)).toThrow(RangeError);
    expect(() => extractSegmentBytes(blob, 0, 1.5)).toThrow(RangeError);
    expect(() => extractSegmentBytes(blob, NaN, 1)).toThrow(RangeError);
  });
});
