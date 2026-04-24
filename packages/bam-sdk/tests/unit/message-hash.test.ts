import { describe, expect, it } from 'vitest';

import type { Address } from '../../src/types.js';
import { computeMessageHash, computeMessageHashForMessage } from '../../src/message.js';

describe('computeMessageHash (ERC-8180 messageHash)', () => {
  it('vector A: all-zero sender, nonce=0, contents = 32 zero bytes', () => {
    const sender = ('0x' + '00'.repeat(20)) as Address;
    const contents = new Uint8Array(32); // tag prefix only, zero bytes
    const hash = computeMessageHash(sender, 0n, contents);
    expect(hash).toBe('0x2af357fc2ab2964b76482ec0fcac3b86f5aca1a8292676023c8b9ec392d821a0');
  });

  it('vector B: sender 0x11.., nonce 42, contents = tag(0xaa..) ‖ "ABC"', () => {
    const sender = ('0x' + '11'.repeat(20)) as Address;
    const contents = new Uint8Array(35);
    contents.fill(0xaa, 0, 32);
    contents.set([0x41, 0x42, 0x43], 32);
    const hash = computeMessageHash(sender, 42n, contents);
    expect(hash).toBe('0xcd85d7e54cb158da66baa2ff0ea40828c61e4d078a320e2c266ad082f8da2656');
  });

  it('computeMessageHashForMessage matches the tuple form', () => {
    const sender = ('0x' + '11'.repeat(20)) as Address;
    const contents = new Uint8Array(35);
    contents.fill(0xaa, 0, 32);
    contents.set([0x41, 0x42, 0x43], 32);
    const tuple = computeMessageHash(sender, 42n, contents);
    const shape = computeMessageHashForMessage({ sender, nonce: 42n, contents });
    expect(shape).toBe(tuple);
  });

  it('changes when any input changes (preimage sensitivity)', () => {
    const sender = ('0x' + '11'.repeat(20)) as Address;
    const contents = new Uint8Array(32);
    const base = computeMessageHash(sender, 1n, contents);

    const diffNonce = computeMessageHash(sender, 2n, contents);
    expect(diffNonce).not.toBe(base);

    const diffSender = computeMessageHash(
      ('0x' + '22'.repeat(20)) as Address,
      1n,
      contents
    );
    expect(diffSender).not.toBe(base);

    const diffContents = new Uint8Array(32);
    diffContents[0] = 1;
    const diffContentsHash = computeMessageHash(sender, 1n, diffContents);
    expect(diffContentsHash).not.toBe(base);
  });

  it('rejects out-of-range nonce', () => {
    const sender = ('0x' + '00'.repeat(20)) as Address;
    const contents = new Uint8Array(32);
    expect(() => computeMessageHash(sender, -1n, contents)).toThrow(RangeError);
    expect(() => computeMessageHash(sender, 1n << 64n, contents)).toThrow(RangeError);
  });

  it('rejects non-20-byte sender', () => {
    const shortSender = '0x1234' as Address;
    const contents = new Uint8Array(32);
    expect(() => computeMessageHash(shortSender, 0n, contents)).toThrow(RangeError);
  });
});
