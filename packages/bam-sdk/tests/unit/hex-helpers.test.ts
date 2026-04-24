import { describe, expect, it } from 'vitest';

import { bytesToHex, hexToBytes } from '../../src/message.js';

describe('hexToBytes', () => {
  it('parses 0x-prefixed hex', () => {
    const bytes = hexToBytes('0x0011ff');
    expect(Array.from(bytes)).toEqual([0x00, 0x11, 0xff]);
  });

  it('parses bare hex (no 0x prefix)', () => {
    const bytes = hexToBytes('0011ff');
    expect(Array.from(bytes)).toEqual([0x00, 0x11, 0xff]);
  });

  it('parses mixed-case hex', () => {
    expect(Array.from(hexToBytes('0xAbCd'))).toEqual([0xab, 0xcd]);
  });

  it('roundtrips through bytesToHex', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    expect(hexToBytes(bytesToHex(bytes))).toEqual(bytes);
  });

  it('returns an empty array for 0x', () => {
    expect(hexToBytes('0x').length).toBe(0);
  });

  it('throws on odd-length hex', () => {
    expect(() => hexToBytes('0xabc')).toThrow(RangeError);
    expect(() => hexToBytes('abc')).toThrow(RangeError);
  });

  it('throws on non-hex characters (no silent NaN coercion)', () => {
    expect(() => hexToBytes('0xzz')).toThrow(RangeError);
    expect(() => hexToBytes('0x00gg')).toThrow(RangeError);
    expect(() => hexToBytes('0x1x')).toThrow(RangeError);
  });
});
