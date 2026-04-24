import { privateKeyToAccount } from 'viem/accounts';
import { createWalletClient, http } from 'viem';
import { foundry } from 'viem/chains';
import { describe, expect, it } from 'vitest';

import type { Address, BAMMessage } from '../../src/types.js';
import {
  signECDSA,
  signECDSAWithKey,
  verifyECDSA,
} from '../../src/signatures.js';

const PRIV = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const ADDR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as Address;

function hexToBytes(hex: string): Uint8Array {
  const c = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(c.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(c.slice(i * 2, i * 2 + 2), 16);
  return out;
}

describe('signECDSA (wallet path) vs signECDSAWithKey (headless)', () => {
  const account = privateKeyToAccount(PRIV);
  const walletClient = createWalletClient({
    account,
    chain: foundry, // chainId = 31337
    transport: http(), // unused — signTypedData is account-local
  });

  const contents = hexToBytes('aa'.repeat(32) + '414243');

  it('byte-identical signature for same (key, message, chainId)', async () => {
    const msg: BAMMessage = { sender: ADDR, nonce: 7n, contents };
    const walletSig = await signECDSA(walletClient, msg);
    const headlessSig = signECDSAWithKey(PRIV, msg, foundry.id);
    expect(walletSig).toBe(headlessSig);
  });

  it('both sigs verify via the same verifyECDSA call', async () => {
    const msg: BAMMessage = { sender: ADDR, nonce: 42n, contents };
    const walletSig = await signECDSA(walletClient, msg);
    const headlessSig = signECDSAWithKey(PRIV, msg, foundry.id);
    expect(verifyECDSA(msg, walletSig, ADDR, foundry.id)).toBe(true);
    expect(verifyECDSA(msg, headlessSig, ADDR, foundry.id)).toBe(true);
  });

  it('wallet sig has v ∈ {27, 28} (normalisation applied)', async () => {
    for (const nonce of [0n, 1n, 10n, 100n]) {
      const sig = await signECDSA(walletClient, { sender: ADDR, nonce, contents });
      const v = parseInt(sig.slice(-2), 16);
      expect([27, 28]).toContain(v);
    }
  });
});
