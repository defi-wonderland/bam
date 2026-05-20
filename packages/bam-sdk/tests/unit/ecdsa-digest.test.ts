import { describe, expect, it } from 'vitest';

import type { Address, Bytes32 } from '../../src/types.js';
import { computeECDSADigest } from '../../src/signatures.js';

describe('computeECDSADigest (EIP-712 over BAMMessage)', () => {
  const sender = ('0x' + '11'.repeat(20)) as Address;
  const tagA = ('0x' + 'aa'.repeat(32)) as Bytes32;
  const tagB = ('0x' + 'bb'.repeat(32)) as Bytes32;
  const contents = hexToBytes('414243'); // "ABC"

  it('deterministic for a pinned input vector', () => {
    const d1 = computeECDSADigest({ sender, nonce: 42n, contents }, tagA, 1);
    const d2 = computeECDSADigest({ sender, nonce: 42n, contents }, tagA, 1);
    expect(d1).toMatch(/^0x[0-9a-f]{64}$/);
    expect(d1).toBe(d2);
  });

  it('chain binding: chainId=31337 yields a distinct digest for the same message', () => {
    const d1 = computeECDSADigest({ sender, nonce: 42n, contents }, tagA, 1);
    const d2 = computeECDSADigest({ sender, nonce: 42n, contents }, tagA, 31337);
    expect(d1).not.toBe(d2);
  });

  it('contentTag binding: same message under a different tag yields a distinct digest', () => {
    const dA = computeECDSADigest({ sender, nonce: 7n, contents }, tagA, 1);
    const dB = computeECDSADigest({ sender, nonce: 7n, contents }, tagB, 1);
    expect(dA).not.toBe(dB);
  });

  it('preimage sensitivity: any field change changes the digest', () => {
    const base = computeECDSADigest({ sender, nonce: 1n, contents }, tagA, 1);

    expect(
      computeECDSADigest({ sender, nonce: 2n, contents }, tagA, 1)
    ).not.toBe(base);

    expect(
      computeECDSADigest(
        { sender: ('0x' + '22'.repeat(20)) as Address, nonce: 1n, contents },
        tagA,
        1
      )
    ).not.toBe(base);

    const altContents = hexToBytes('414244');
    expect(
      computeECDSADigest({ sender, nonce: 1n, contents: altContents }, tagA, 1)
    ).not.toBe(base);

    expect(
      computeECDSADigest({ sender, nonce: 1n, contents }, tagA, 2)
    ).not.toBe(base);
  });
});

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
