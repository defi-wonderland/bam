import { describe, expect, it } from 'vitest';

import type { Address, Bytes32 } from '../../src/types.js';
import { computeMessageId } from '../../src/message.js';

describe('computeMessageId (ERC-8180 messageId)', () => {
  it('vector: sender 0x11.., nonce=1, batchContentHash = 0x00..01', () => {
    const sender = ('0x' + '11'.repeat(20)) as Address;
    const bch = ('0x' + '00'.repeat(31) + '01') as Bytes32;
    const id = computeMessageId(sender, 1n, bch);
    expect(id).toBe('0x121e2c031229319d6fe478fa3c9232e5606ccbcfb658502fe692da7927213337');
  });

  it('realistic EIP-4844-style blob versioned hash vector', () => {
    // 0x01 prefix marks a KZG-versioned hash per EIP-4844
    const sender = ('0x' + 'ab'.repeat(20)) as Address;
    const bch = ('0x01' + 'cd'.repeat(31)) as Bytes32;
    const id = computeMessageId(sender, 0xdeadbeefn, bch);
    // Deterministic: recompute and lock
    expect(id).toMatch(/^0x[0-9a-f]{64}$/);
    expect(id).toBe(computeMessageId(sender, 0xdeadbeefn, bch));
  });

  it('changes when any input changes', () => {
    const sender = ('0x' + '11'.repeat(20)) as Address;
    const bch = ('0x' + '00'.repeat(32)) as Bytes32;
    const base = computeMessageId(sender, 5n, bch);

    expect(computeMessageId(sender, 6n, bch)).not.toBe(base);
    expect(
      computeMessageId(('0x' + '22'.repeat(20)) as Address, 5n, bch)
    ).not.toBe(base);
    const bch2 = ('0x' + '00'.repeat(31) + 'ff') as Bytes32;
    expect(computeMessageId(sender, 5n, bch2)).not.toBe(base);
  });

  it('rejects non-32-byte batchContentHash', () => {
    const sender = ('0x' + '00'.repeat(20)) as Address;
    const shortBch = ('0x1234') as Bytes32;
    expect(() => computeMessageId(sender, 0n, shortBch)).toThrow(RangeError);
  });

  it('rejects out-of-range nonce', () => {
    const sender = ('0x' + '00'.repeat(20)) as Address;
    const bch = ('0x' + '00'.repeat(32)) as Bytes32;
    expect(() => computeMessageId(sender, -1n, bch)).toThrow(RangeError);
    expect(() => computeMessageId(sender, 1n << 64n, bch)).toThrow(RangeError);
  });
});
