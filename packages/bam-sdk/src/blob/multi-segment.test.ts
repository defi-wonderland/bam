import { describe, expect, it } from 'vitest';
import {
  BYTES_PER_BLOB,
  BYTES_PER_FIELD_ELEMENT,
  FIELD_ELEMENTS_PER_BLOB,
  USABLE_BYTES_PER_FIELD_ELEMENT,
} from './constants.js';
import { assembleMultiSegmentBlob } from './multi-segment.js';
import type { Bytes32 } from '../types.js';

const TAG_A: Bytes32 = '0x' + '11'.repeat(32) as Bytes32;
const TAG_B: Bytes32 = '0x' + '22'.repeat(32) as Bytes32;
const TAG_C: Bytes32 = '0x' + '33'.repeat(32) as Bytes32;

function payloadOfLength(len: number, fillByte = 0xab): Uint8Array {
  const buf = new Uint8Array(len);
  buf.fill(fillByte);
  return buf;
}

describe('assembleMultiSegmentBlob', () => {
  it('returns an empty blob with no segments when input is empty', () => {
    const { blob, segments } = assembleMultiSegmentBlob([]);
    expect(blob).toHaveLength(BYTES_PER_BLOB);
    expect(blob.every((b) => b === 0)).toBe(true);
    expect(segments).toEqual([]);
  });

  it('lays a 1-byte single segment at FE [0, 1)', () => {
    const { blob, segments } = assembleMultiSegmentBlob([
      { contentTag: TAG_A, payload: new Uint8Array([0x42]) },
    ]);
    expect(segments).toEqual([{ contentTag: TAG_A, startFE: 0, endFE: 1 }]);
    // Byte 0 of FE 0 is padding; payload byte lives at index 1.
    expect(blob[0]).toBe(0x00);
    expect(blob[1]).toBe(0x42);
    // Subsequent bytes are zero.
    expect(blob[BYTES_PER_FIELD_ELEMENT]).toBe(0x00);
  });

  it('tiles two segments to exactly 4096 FEs without gap or padding', () => {
    const halfBytes = (FIELD_ELEMENTS_PER_BLOB / 2) * USABLE_BYTES_PER_FIELD_ELEMENT;
    const a = payloadOfLength(halfBytes, 0xaa);
    const b = payloadOfLength(halfBytes, 0xbb);

    const { blob, segments } = assembleMultiSegmentBlob([
      { contentTag: TAG_A, payload: a },
      { contentTag: TAG_B, payload: b },
    ]);

    expect(segments).toEqual([
      { contentTag: TAG_A, startFE: 0, endFE: FIELD_ELEMENTS_PER_BLOB / 2 },
      { contentTag: TAG_B, startFE: FIELD_ELEMENTS_PER_BLOB / 2, endFE: FIELD_ELEMENTS_PER_BLOB },
    ]);

    // Spot-check: at start of segment B, byte 0 of its first FE is padding (0x00),
    // then 31 bytes of 0xbb.
    const bStartByte = (FIELD_ELEMENTS_PER_BLOB / 2) * BYTES_PER_FIELD_ELEMENT;
    expect(blob[bStartByte]).toBe(0x00);
    expect(blob[bStartByte + 1]).toBe(0xbb);
    expect(blob[bStartByte + USABLE_BYTES_PER_FIELD_ELEMENT]).toBe(0xbb);
  });

  it('positions three segments at boundary FE positions', () => {
    const lenA = USABLE_BYTES_PER_FIELD_ELEMENT; // 1 FE
    const lenB = USABLE_BYTES_PER_FIELD_ELEMENT * 2; // 2 FEs
    const lenC = USABLE_BYTES_PER_FIELD_ELEMENT * 3; // 3 FEs
    const { segments } = assembleMultiSegmentBlob([
      { contentTag: TAG_A, payload: payloadOfLength(lenA) },
      { contentTag: TAG_B, payload: payloadOfLength(lenB) },
      { contentTag: TAG_C, payload: payloadOfLength(lenC) },
    ]);

    expect(segments).toEqual([
      { contentTag: TAG_A, startFE: 0, endFE: 1 },
      { contentTag: TAG_B, startFE: 1, endFE: 3 },
      { contentTag: TAG_C, startFE: 3, endFE: 6 },
    ]);
  });

  it('throws when aggregate endFE would exceed FIELD_ELEMENTS_PER_BLOB', () => {
    const halfPlusOne =
      (FIELD_ELEMENTS_PER_BLOB / 2) * USABLE_BYTES_PER_FIELD_ELEMENT
      + USABLE_BYTES_PER_FIELD_ELEMENT;
    const halfRest =
      (FIELD_ELEMENTS_PER_BLOB / 2) * USABLE_BYTES_PER_FIELD_ELEMENT;

    expect(() =>
      assembleMultiSegmentBlob([
        { contentTag: TAG_A, payload: payloadOfLength(halfPlusOne) },
        { contentTag: TAG_B, payload: payloadOfLength(halfRest) },
      ])
    ).toThrow(/aggregate endFE/);
  });

  it('emits no extra padding FE for a 31-byte multiple payload', () => {
    const exactly3FEs = USABLE_BYTES_PER_FIELD_ELEMENT * 3;
    const { segments } = assembleMultiSegmentBlob([
      { contentTag: TAG_A, payload: payloadOfLength(exactly3FEs) },
    ]);
    expect(segments).toEqual([{ contentTag: TAG_A, startFE: 0, endFE: 3 }]);
  });

  it('rounds a non-multiple payload up to the next FE', () => {
    const payload = payloadOfLength(USABLE_BYTES_PER_FIELD_ELEMENT + 1); // 32 usable bytes
    const { segments } = assembleMultiSegmentBlob([
      { contentTag: TAG_A, payload },
    ]);
    expect(segments).toEqual([{ contentTag: TAG_A, startFE: 0, endFE: 2 }]);
  });
});
