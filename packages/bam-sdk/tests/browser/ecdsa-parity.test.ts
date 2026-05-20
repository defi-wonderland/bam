import { describe, expect, it } from 'vitest';

import type { Address, BAMMessage, Bytes32 } from '../../src/types.js';
import {
  signECDSAWithKey,
  verifyECDSA,
  computeECDSADigest,
} from '../../src/signatures.js';

/**
 * Cross-runtime signature parity (browser side). Pairs with
 * `tests/unit/ecdsa-node-reference.test.ts` (Node side) — both compute
 * the same digest and signature for a shared `(privateKey, message,
 * contentTag, chainId)` input and the assertions below confirm the
 * jsdom runtime is functional and self-consistent. The actual
 * cross-runtime byte-equality is exercised by the broader parity
 * smoke test (gate G-5).
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

describe('cross-runtime ECDSA parity (browser)', () => {
  const msg: BAMMessage = {
    sender: ADDR,
    nonce: 42n,
    contents: hexToBytes('414243'),
  };

  it('EIP-712 digest is deterministic 32-byte hex', () => {
    const d = computeECDSADigest(msg, TAG, 31337);
    expect(d).toMatch(/^0x[0-9a-f]{64}$/);
    expect(d).toBe(computeECDSADigest(msg, TAG, 31337));
  });

  it('signature verifies under jsdom', () => {
    const sig = signECDSAWithKey(PRIV, msg, TAG, 31337);
    expect(verifyECDSA(msg, TAG, sig, ADDR, 31337)).toBe(true);
  });

  it('verifyECDSA rejects when contentTag differs from what was signed', () => {
    const tagB = ('0x' + 'bb'.repeat(32)) as Bytes32;
    const sig = signECDSAWithKey(PRIV, msg, TAG, 31337);
    expect(verifyECDSA(msg, tagB, sig, ADDR, 31337)).toBe(false);
  });
});
