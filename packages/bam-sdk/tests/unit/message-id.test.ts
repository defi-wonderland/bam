import { describe, expect, it } from 'vitest';

import type { Address, Bytes32 } from '../../src/types.js';
import { computeMessageId } from '../../src/message.js';

const ZERO_TAG = ('0x' + '00'.repeat(32)) as Bytes32;
const TAG_A = ('0x' + 'aa'.repeat(32)) as Bytes32;
const TAG_B = ('0x' + 'bb'.repeat(32)) as Bytes32;

describe('computeMessageId (ERC-8180 messageId)', () => {
  it('deterministic for a fixed input vector', () => {
    const sender = ('0x' + '11'.repeat(20)) as Address;
    const bch = ('0x' + '00'.repeat(31) + '01') as Bytes32;
    const id = computeMessageId(sender, TAG_A, 1n, bch);
    expect(id).toMatch(/^0x[0-9a-f]{64}$/);
    expect(id).toBe(computeMessageId(sender, TAG_A, 1n, bch));
  });

  it('realistic EIP-4844-style blob versioned hash vector', () => {
    const sender = ('0x' + 'ab'.repeat(20)) as Address;
    const bch = ('0x01' + 'cd'.repeat(31)) as Bytes32;
    const id = computeMessageId(sender, TAG_A, 0xdeadbeefn, bch);
    expect(id).toMatch(/^0x[0-9a-f]{64}$/);
    expect(id).toBe(computeMessageId(sender, TAG_A, 0xdeadbeefn, bch));
  });

  it('changes when any input changes', () => {
    const sender = ('0x' + '11'.repeat(20)) as Address;
    const bch = ('0x' + '00'.repeat(32)) as Bytes32;
    const base = computeMessageId(sender, TAG_A, 5n, bch);

    expect(computeMessageId(sender, TAG_A, 6n, bch)).not.toBe(base);
    expect(
      computeMessageId(('0x' + '22'.repeat(20)) as Address, TAG_A, 5n, bch)
    ).not.toBe(base);
    const bch2 = ('0x' + '00'.repeat(31) + 'ff') as Bytes32;
    expect(computeMessageId(sender, TAG_A, 5n, bch2)).not.toBe(base);
  });

  it('binds contentTag: same (sender, nonce, contentHash) under distinct tags yields distinct IDs', () => {
    const sender = ('0x' + '11'.repeat(20)) as Address;
    const bch = ('0x' + '00'.repeat(32)) as Bytes32;
    const idA = computeMessageId(sender, TAG_A, 9n, bch);
    const idB = computeMessageId(sender, TAG_B, 9n, bch);
    expect(idA).not.toBe(idB);
  });

  it('rejects non-32-byte batchContentHash', () => {
    const sender = ('0x' + '00'.repeat(20)) as Address;
    const shortBch = '0x1234' as Bytes32;
    expect(() => computeMessageId(sender, ZERO_TAG, 0n, shortBch)).toThrow(RangeError);
  });

  it('rejects non-32-byte contentTag', () => {
    const sender = ('0x' + '00'.repeat(20)) as Address;
    const bch = ('0x' + '00'.repeat(32)) as Bytes32;
    const shortTag = '0xaa' as Bytes32;
    expect(() => computeMessageId(sender, shortTag, 0n, bch)).toThrow(RangeError);
  });

  it('rejects out-of-range nonce', () => {
    const sender = ('0x' + '00'.repeat(20)) as Address;
    const bch = ('0x' + '00'.repeat(32)) as Bytes32;
    expect(() => computeMessageId(sender, ZERO_TAG, -1n, bch)).toThrow(RangeError);
    expect(() => computeMessageId(sender, ZERO_TAG, 1n << 64n, bch)).toThrow(RangeError);
  });
});
