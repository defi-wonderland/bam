import { describe, expect, it } from 'vitest';

import {
  BYTES_PER_FIELD_ELEMENT,
  FIELD_ELEMENTS_PER_BLOB,
  USABLE_BYTES_PER_BLOB,
  USABLE_BYTES_PER_FIELD_ELEMENT,
  extractUsableBytes,
} from '../../src/blob-fetch/extract.js';

const FULL_BLOB_BYTES = FIELD_ELEMENTS_PER_BLOB * BYTES_PER_FIELD_ELEMENT;

function buildBlob(fill: (fe: number, off: number) => number): Uint8Array {
  const blob = new Uint8Array(FULL_BLOB_BYTES);
  for (let fe = 0; fe < FIELD_ELEMENTS_PER_BLOB; fe++) {
    for (let off = 0; off < BYTES_PER_FIELD_ELEMENT; off++) {
      blob[fe * BYTES_PER_FIELD_ELEMENT + off] = fill(fe, off);
    }
  }
  return blob;
}

describe('extractUsableBytes', () => {
  it('produces 4096 × 31 usable bytes from a full-blob input', () => {
    const blob = buildBlob(() => 0);
    const out = extractUsableBytes(blob);
    expect(out.length).toBe(USABLE_BYTES_PER_BLOB);
    expect(out.length).toBe(FIELD_ELEMENTS_PER_BLOB * USABLE_BYTES_PER_FIELD_ELEMENT);
  });

  it('drops byte 0 of every field element', () => {
    // byte 0 of each FE encodes a sentinel that is *never* produced by the
    // payload-encoding scheme below: bytes 1..31 are restricted to 0..30.
    const blob = buildBlob((fe, off) => {
      if (off === 0) return 0x80 | (fe & 0x7f);
      return (off - 1) & 0x1f;
    });
    const out = extractUsableBytes(blob);
    for (let fe = 0; fe < FIELD_ELEMENTS_PER_BLOB; fe++) {
      for (let i = 0; i < USABLE_BYTES_PER_FIELD_ELEMENT; i++) {
        expect(out[fe * USABLE_BYTES_PER_FIELD_ELEMENT + i]).toBe(i & 0x1f);
      }
    }
    // No byte ≥ 0x80 should survive — every such byte was a byte-0 sentinel.
    for (let i = 0; i < out.length; i++) {
      expect(out[i] & 0x80).toBe(0);
    }
  });

  it('is deterministic across repeated calls on the same input', () => {
    const blob = buildBlob((fe, off) => (fe ^ off) & 0xff);
    const a = extractUsableBytes(blob);
    const b = extractUsableBytes(blob);
    expect(a).toEqual(b);
  });

  it('rejects inputs of the wrong length', () => {
    expect(() => extractUsableBytes(new Uint8Array(1024))).toThrow(RangeError);
    expect(() => extractUsableBytes(new Uint8Array(FULL_BLOB_BYTES + 1))).toThrow(
      RangeError
    );
  });
});
