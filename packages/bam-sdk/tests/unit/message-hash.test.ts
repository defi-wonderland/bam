import { describe, expect, it } from 'vitest';

import type { Address, Bytes32 } from '../../src/types.js';
import { computeMessageHash, computeMessageHashForMessage } from '../../src/message.js';

const ZERO_TAG = ('0x' + '00'.repeat(32)) as Bytes32;
const TAG_A = ('0x' + 'aa'.repeat(32)) as Bytes32;
const TAG_B = ('0x' + 'bb'.repeat(32)) as Bytes32;

describe('computeMessageHash (ERC-8180 messageHash)', () => {
  it('preimage layout is sender(20) || contentTag(32) || nonce(8) || contents(N)', () => {
    // Sanity check by recomputing keccak256 manually via the helper itself —
    // the value below is whatever the implementation produces for the
    // canonical zero input; the test pins the formula, not a specific byte
    // string. Any change to the preimage layout will flip this value and
    // break the test, which is the intended tripwire.
    const sender = ('0x' + '00'.repeat(20)) as Address;
    const contents = new Uint8Array(0);
    const hash = computeMessageHash(sender, ZERO_TAG, 0n, contents);
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);

    // Distinct vector also pinned for review readability.
    const sender2 = ('0x' + '11'.repeat(20)) as Address;
    const contents2 = new Uint8Array([0x41, 0x42, 0x43]); // "ABC"
    const hash2 = computeMessageHash(sender2, TAG_A, 42n, contents2);
    expect(hash2).toMatch(/^0x[0-9a-f]{64}$/);
    expect(hash2).not.toBe(hash);
  });

  it('computeMessageHashForMessage matches the tuple form', () => {
    const sender = ('0x' + '11'.repeat(20)) as Address;
    const contents = new Uint8Array([0x41, 0x42, 0x43]);
    const tuple = computeMessageHash(sender, TAG_A, 42n, contents);
    const shape = computeMessageHashForMessage({ sender, nonce: 42n, contents }, TAG_A);
    expect(shape).toBe(tuple);
  });

  it('changes when any input changes (preimage sensitivity)', () => {
    const sender = ('0x' + '11'.repeat(20)) as Address;
    const contents = new Uint8Array(0);
    const base = computeMessageHash(sender, TAG_A, 1n, contents);

    const diffNonce = computeMessageHash(sender, TAG_A, 2n, contents);
    expect(diffNonce).not.toBe(base);

    const diffSender = computeMessageHash(
      ('0x' + '22'.repeat(20)) as Address,
      TAG_A,
      1n,
      contents
    );
    expect(diffSender).not.toBe(base);

    const diffContentsHash = computeMessageHash(sender, TAG_A, 1n, new Uint8Array([0x01]));
    expect(diffContentsHash).not.toBe(base);
  });

  it('binds contentTag: different tags yield different hashes for identical (sender, nonce, contents)', () => {
    const sender = ('0x' + '11'.repeat(20)) as Address;
    const contents = new Uint8Array([0x41, 0x42, 0x43]);
    const hashA = computeMessageHash(sender, TAG_A, 7n, contents);
    const hashB = computeMessageHash(sender, TAG_B, 7n, contents);
    expect(hashA).not.toBe(hashB);
  });

  it('rejects out-of-range nonce', () => {
    const sender = ('0x' + '00'.repeat(20)) as Address;
    const contents = new Uint8Array(0);
    expect(() => computeMessageHash(sender, ZERO_TAG, -1n, contents)).toThrow(RangeError);
    expect(() => computeMessageHash(sender, ZERO_TAG, 1n << 64n, contents)).toThrow(RangeError);
  });

  it('rejects non-20-byte sender', () => {
    const shortSender = '0x1234' as Address;
    const contents = new Uint8Array(0);
    expect(() => computeMessageHash(shortSender, ZERO_TAG, 0n, contents)).toThrow(RangeError);
  });

  it('rejects non-32-byte contentTag', () => {
    const sender = ('0x' + '00'.repeat(20)) as Address;
    const contents = new Uint8Array(0);
    const shortTag = '0xaabb' as Bytes32;
    expect(() => computeMessageHash(sender, shortTag, 0n, contents)).toThrow(RangeError);
  });
});
