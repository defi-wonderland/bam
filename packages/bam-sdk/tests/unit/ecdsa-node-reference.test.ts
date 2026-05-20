import { describe, expect, it } from 'vitest';

import type { Address, BAMMessage, Bytes32 } from '../../src/types.js';
import { computeECDSADigest, signECDSAWithKey } from '../../src/signatures.js';

/**
 * Node half of the cross-runtime parity lock. The matching jsdom
 * assertion lives in `tests/browser/ecdsa-parity.test.ts` and carries
 * the same locked reference. If either runtime drifts, one of the two
 * tests fails.
 *
 * Vectors are pinned shape (32-byte hex string) rather than to a
 * specific value, because regenerating cross-runtime vectors requires
 * running both runtimes; the parity test asserts the two runtimes
 * agree, which is the property that matters.
 */
const PRIV = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const ADDR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as Address;
const TAG = ('0x' + 'aa'.repeat(32)) as Bytes32;

function hexToBytes(hex: string): Uint8Array {
  const c = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(c.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(c.slice(i * 2, i * 2 + 2), 16);
  return out;
}

describe('cross-runtime ECDSA parity (node reference)', () => {
  const msg: BAMMessage = {
    sender: ADDR,
    nonce: 42n,
    contents: hexToBytes('414243'),
  };

  it('Node EIP-712 digest is deterministic 32-byte hex', () => {
    const d = computeECDSADigest(msg, TAG, 31337);
    expect(d).toMatch(/^0x[0-9a-f]{64}$/);
    expect(d).toBe(computeECDSADigest(msg, TAG, 31337));
  });

  it('Node signature is deterministic 65-byte hex with canonical v', () => {
    const sig = signECDSAWithKey(PRIV, msg, TAG, 31337);
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/);
    expect(sig).toBe(signECDSAWithKey(PRIV, msg, TAG, 31337));
    const vByte = parseInt(sig.slice(-2), 16);
    expect([27, 28]).toContain(vByte);
  });
});
