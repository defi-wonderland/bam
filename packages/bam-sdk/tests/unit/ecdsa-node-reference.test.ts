import { describe, expect, it } from 'vitest';

import type { Address, BAMMessage } from '../../src/types.js';
import { computeECDSADigest, signECDSAWithKey } from '../../src/signatures.js';

/**
 * Node half of the cross-runtime parity lock. The matching jsdom
 * assertion lives in `tests/browser/ecdsa-parity.test.ts` and carries
 * the same locked reference. If either runtime drifts, one of the two
 * tests fails.
 */
const PRIV = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const ADDR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as Address;

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
    contents: hexToBytes('aa'.repeat(32) + '414243'),
  };

  it('Node EIP-712 digest matches the locked vector', () => {
    expect(computeECDSADigest(msg, 31337)).toBe(
      '0xad6d71d2e97da1f6de7aa8156b28a280bf02d4aad802cd7b7f53e38b56ae65d8'
    );
  });

  it('Node signature matches the locked vector', () => {
    const NODE_REFERENCE =
      '0x74c3e7dd625758122a454640bda36f14db07e2db13d6fcf1cd5aab0ce6011d5e0b3c97853fad4e9573c0225aa857a4d869cb81434b1453f6f74e3c59cbc2a9911b';
    expect(signECDSAWithKey(PRIV, msg, 31337)).toBe(NODE_REFERENCE);
  });
});
