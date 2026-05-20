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
 * contentTag, chainId)` input and lock the same reference bytes. If
 * either runtime drifts (keccak, EIP-712 struct order, secp256k1
 * deterministic-k derivation, low-s), one of the two tests fails.
 *
 * The locked vectors here MUST stay byte-equal to the Node file;
 * update both in lock-step after any intentional change.
 */

const PRIV = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const ADDR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as Address;
const TAG = ('0x' + 'aa'.repeat(32)) as Bytes32;
const CHAIN_ID = 31337;

// MUST match ecdsa-node-reference.test.ts byte-for-byte.
const EXPECTED_DIGEST =
  '0x71fe74b4d855abb11101d7925104bc37c8434f8ef826e5c03d11f9ed67edd76e';
const EXPECTED_SIG =
  '0x2ab85c83a826ce6e8e63b0940eb346aef0a9e09ce80f7a053f57986bf34213ef32467eb1174ffef57462a35db2912db1495e99c195417d31cf29cf501dc09b941c';

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

  it('jsdom EIP-712 digest matches the locked reference', () => {
    const d = computeECDSADigest(msg, TAG, CHAIN_ID);
    expect(d).toBe(EXPECTED_DIGEST);
  });

  it('jsdom signature matches the locked reference and verifies', () => {
    const sig = signECDSAWithKey(PRIV, msg, TAG, CHAIN_ID);
    expect(sig).toBe(EXPECTED_SIG);
    expect(verifyECDSA(msg, TAG, sig, ADDR, CHAIN_ID)).toBe(true);
  });

  it('verifyECDSA rejects when contentTag differs from what was signed', () => {
    const tagB = ('0x' + 'bb'.repeat(32)) as Bytes32;
    const sig = signECDSAWithKey(PRIV, msg, TAG, CHAIN_ID);
    expect(verifyECDSA(msg, tagB, sig, ADDR, CHAIN_ID)).toBe(false);
  });
});
