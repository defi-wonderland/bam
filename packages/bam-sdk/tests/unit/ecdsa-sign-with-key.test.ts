import { describe, expect, it } from 'vitest';

import type { Address, BAMMessage } from '../../src/types.js';
import { signECDSAWithKey } from '../../src/signatures.js';

// Deterministic test key — never use for anything else. This is Anvil's
// default mnemonic account[0].
const PRIV = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;

function hexToBytes(hex: string): Uint8Array {
  const c = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(c.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(c.slice(i * 2, i * 2 + 2), 16);
  return out;
}

describe('signECDSAWithKey', () => {
  const sender = ('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as Address);
  const contents = hexToBytes('aa'.repeat(32) + '414243');
  const msg: BAMMessage = { sender, nonce: 42n, contents };

  it('produces a 65-byte signature', () => {
    const sig = signECDSAWithKey(PRIV, msg, 1);
    expect(sig.length).toBe(2 + 65 * 2); // '0x' + 130 hex chars
    expect(sig).toMatch(/^0x[0-9a-fA-F]{130}$/);
  });

  it('is deterministic for the same (key, message, chainId)', () => {
    const sigA = signECDSAWithKey(PRIV, msg, 1);
    const sigB = signECDSAWithKey(PRIV, msg, 1);
    expect(sigA).toBe(sigB);
  });

  it('differs across chainIds', () => {
    const sigA = signECDSAWithKey(PRIV, msg, 1);
    const sigB = signECDSAWithKey(PRIV, msg, 31337);
    expect(sigA).not.toBe(sigB);
  });

  it('v byte is 27 or 28 (canonical Ethereum encoding)', () => {
    for (const nonce of [0n, 1n, 42n, 100n, 0xdeadbeefn]) {
      const sig = signECDSAWithKey(PRIV, { ...msg, nonce }, 1);
      const v = parseInt(sig.slice(-2), 16);
      expect([27, 28]).toContain(v);
    }
  });

  it('s half is low (canonical — no high-s signatures emitted)', () => {
    // secp256k1 curve order / 2
    const HALF_N =
      0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
    for (const nonce of [0n, 1n, 42n, 100n, 0xdeadbeefn]) {
      const sig = signECDSAWithKey(PRIV, { ...msg, nonce }, 1);
      const sHex = sig.slice(2 + 64, 2 + 128);
      const s = BigInt('0x' + sHex);
      expect(s <= HALF_N).toBe(true);
    }
  });
});
