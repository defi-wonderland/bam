import { describe, it, expect } from 'vitest';

import {
  NONCE_TEXT_WIDTH,
  MAX_NONCE,
  NonceCodecError,
  decodeNonce,
  encodeNonce,
} from '../../src/pool/nonce-codec.js';

describe('nonce codec', () => {
  it('round-trips the boundary values (0, 1, 2^63, 2^64-1)', () => {
    const values: bigint[] = [0n, 1n, 1n << 63n, MAX_NONCE];
    for (const n of values) {
      const text = encodeNonce(n);
      expect(text).toHaveLength(NONCE_TEXT_WIDTH);
      expect(decodeNonce(text)).toBe(n);
    }
  });

  it('zero-pads so lexicographic order matches numeric order', () => {
    const encoded = [0n, 1n, 10n, 100n, 1_000_000n, MAX_NONCE].map(encodeNonce);
    const sorted = [...encoded].sort();
    expect(sorted).toEqual(encoded);
  });

  it('refuses negative nonces', () => {
    expect(() => encodeNonce(-1n)).toThrow(NonceCodecError);
  });

  it('refuses nonces above uint64 max', () => {
    expect(() => encodeNonce(MAX_NONCE + 1n)).toThrow(NonceCodecError);
  });

  it('rejects text of the wrong width', () => {
    expect(() => decodeNonce('1')).toThrow(NonceCodecError);
    expect(() => decodeNonce('0'.repeat(19))).toThrow(NonceCodecError);
    expect(() => decodeNonce('0'.repeat(21))).toThrow(NonceCodecError);
  });

  it('rejects non-digit text', () => {
    expect(() => decodeNonce('0'.repeat(19) + 'x')).toThrow(NonceCodecError);
    expect(() => decodeNonce(' '.repeat(20))).toThrow(NonceCodecError);
  });

  it('always produces the same width regardless of the input magnitude', () => {
    for (const n of [0n, 7n, 1_000n, 1n << 40n, MAX_NONCE]) {
      expect(encodeNonce(n)).toHaveLength(20);
    }
  });
});
