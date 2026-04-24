import { describe, expect, it } from 'vitest';

import type { Address, BAMMessage } from '../../src/types.js';
import {
  signECDSAWithKey,
  verifyECDSA,
  computeECDSADigest,
} from '../../src/signatures.js';

/**
 * Cross-runtime signature parity.
 *
 * The same `(privateKey, BAMMessage, chainId)` tuple produces byte-
 * identical signatures whether executed under Node (tests/unit/) or
 * under jsdom (this file). The Node expected values are pasted in as
 * locked vectors; any drift between runtimes fails the assertion.
 */

const PRIV = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const ADDR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as Address;

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
    contents: hexToBytes('aa'.repeat(32) + '414243'),
  };

  it('EIP-712 digest matches the Node vector', () => {
    expect(computeECDSADigest(msg, 31337)).toBe(
      '0xad6d71d2e97da1f6de7aa8156b28a280bf02d4aad802cd7b7f53e38b56ae65d8'
    );
  });

  it('signature verifies under jsdom', () => {
    const sig = signECDSAWithKey(PRIV, msg, 31337);
    expect(verifyECDSA(msg, sig, ADDR, 31337)).toBe(true);
  });

  it('signature matches the Node-runtime locked vector', () => {
    // Locked vector: this exact 65-byte signature was produced by
    // `signECDSAWithKey` under Node for the same (key, message,
    // chainId). If the jsdom runtime produces a different output,
    // the runtimes have drifted. ECDSA signing is deterministic
    // under our setup (@noble's sync signing is RFC 6979
    // deterministic), so drift between runtimes would indicate a
    // genuine divergence, not a nondeterminism artifact.
    const NODE_REFERENCE =
      '0x74c3e7dd625758122a454640bda36f14db07e2db13d6fcf1cd5aab0ce6011d5e0b3c97853fad4e9573c0225aa857a4d869cb81434b1453f6f74e3c59cbc2a9911b';
    const sig = signECDSAWithKey(PRIV, msg, 31337);
    expect(sig).toBe(NODE_REFERENCE);
  });
});
