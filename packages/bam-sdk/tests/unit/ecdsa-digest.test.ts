import { describe, expect, it } from 'vitest';

import type { Address } from '../../src/types.js';
import { computeECDSADigest } from '../../src/signatures.js';

describe('computeECDSADigest (EIP-712 over BAMMessage)', () => {
  const sender = ('0x' + '11'.repeat(20)) as Address;
  const tagPrefix = 'aa'.repeat(32);
  const app = '414243'; // "ABC"
  const contents = hexToBytes(tagPrefix + app);

  it('locked vector: chainId=1, nonce=42, contents = tag(0xaa..) ‖ "ABC"', () => {
    const digest = computeECDSADigest({ sender, nonce: 42n, contents }, 1);
    expect(digest).toBe('0xbc7a35fc6bc9350a05ce1f2c8f1f2369ae1ece870dd19826f5265b79d444838c');
  });

  it('chain binding: chainId=31337 yields a distinct digest for the same message', () => {
    const digest = computeECDSADigest({ sender, nonce: 42n, contents }, 31337);
    expect(digest).toBe('0x736491f137203caae904a9f8c17b02856b2daeb0dc1a4bd637d3749be50d2c83');
  });

  it('preimage sensitivity: any field change changes the digest', () => {
    const base = computeECDSADigest({ sender, nonce: 1n, contents }, 1);

    expect(
      computeECDSADigest({ sender, nonce: 2n, contents }, 1)
    ).not.toBe(base);

    expect(
      computeECDSADigest(
        { sender: ('0x' + '22'.repeat(20)) as Address, nonce: 1n, contents },
        1
      )
    ).not.toBe(base);

    // Tamper the tag prefix (first 32 bytes of contents)
    const tagTamper = hexToBytes('ab' + 'aa'.repeat(31) + app);
    expect(
      computeECDSADigest({ sender, nonce: 1n, contents: tagTamper }, 1)
    ).not.toBe(base);

    // Tamper the app bytes (after the 32-byte prefix)
    const appTamper = hexToBytes(tagPrefix + '414244');
    expect(
      computeECDSADigest({ sender, nonce: 1n, contents: appTamper }, 1)
    ).not.toBe(base);

    expect(
      computeECDSADigest({ sender, nonce: 1n, contents }, 2)
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
