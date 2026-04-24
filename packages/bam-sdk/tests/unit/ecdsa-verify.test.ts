import * as secp256k1 from '@noble/secp256k1';
import { describe, expect, it } from 'vitest';

import type { Address, BAMMessage } from '../../src/types.js';
import {
  computeECDSADigest,
  signECDSAWithKey,
  verifyECDSA,
} from '../../src/signatures.js';

const PRIV = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
// Corresponding Ethereum address (Anvil default account[0]).
const ADDR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as Address;

function hexToBytes(hex: string): Uint8Array {
  const c = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(c.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(c.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function bytesToHex(b: Uint8Array): `0x${string}` {
  return ('0x' + Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('')) as `0x${string}`;
}

const SECP_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

describe('verifyECDSA', () => {
  const tag = 'aa'.repeat(32);
  const contents = hexToBytes(tag + '414243');
  const msg: BAMMessage = { sender: ADDR, nonce: 7n, contents };
  const CHAIN = 31337;

  it('accepts a valid signature produced by signECDSAWithKey', () => {
    const sig = signECDSAWithKey(PRIV, msg, CHAIN);
    expect(verifyECDSA(msg, sig, ADDR, CHAIN)).toBe(true);
  });

  it('rejects against a different expectedSender', () => {
    const sig = signECDSAWithKey(PRIV, msg, CHAIN);
    const wrong = ('0x' + '22'.repeat(20)) as Address;
    expect(verifyECDSA(msg, sig, wrong, CHAIN)).toBe(false);
  });

  it('rejects against a different chainId (cross-chain replay blocked)', () => {
    const sig = signECDSAWithKey(PRIV, msg, CHAIN);
    expect(verifyECDSA(msg, sig, ADDR, 1)).toBe(false);
  });

  it('rejects when contents are tampered outside the tag prefix', () => {
    const sig = signECDSAWithKey(PRIV, msg, CHAIN);
    const tampered: BAMMessage = {
      ...msg,
      contents: hexToBytes(tag + '414244'),
    };
    expect(verifyECDSA(tampered, sig, ADDR, CHAIN)).toBe(false);
  });

  it('rejects when the contentTag prefix is tampered', () => {
    const sig = signECDSAWithKey(PRIV, msg, CHAIN);
    const tagTampered = 'bb'.repeat(32);
    const tampered: BAMMessage = {
      ...msg,
      contents: hexToBytes(tagTampered + '414243'),
    };
    expect(verifyECDSA(tampered, sig, ADDR, CHAIN)).toBe(false);
  });

  it('rejects a tampered nonce', () => {
    const sig = signECDSAWithKey(PRIV, msg, CHAIN);
    expect(verifyECDSA({ ...msg, nonce: 8n }, sig, ADDR, CHAIN)).toBe(false);
  });

  it('rejects signature lengths ≠ 65 bytes', () => {
    for (const n of [48, 64, 66, 96, 128]) {
      const fake = bytesToHex(new Uint8Array(n));
      expect(verifyECDSA(msg, fake, ADDR, CHAIN)).toBe(false);
    }
  });

  it('rejects high-s signature (malleability)', () => {
    const sig = signECDSAWithKey(PRIV, msg, CHAIN);
    const sigBytes = hexToBytes(sig);
    // Flip to high-s by computing n - s.
    const sHex =
      '0x' + Array.from(sigBytes.slice(32, 64)).map((x) => x.toString(16).padStart(2, '0')).join('');
    const s = BigInt(sHex);
    const sHigh = SECP_N - s;
    const sHighBytes = new Uint8Array(32);
    let tmp = sHigh;
    for (let i = 31; i >= 0; i--) {
      sHighBytes[i] = Number(tmp & 0xffn);
      tmp >>= 8n;
    }
    const mutated = new Uint8Array(65);
    mutated.set(sigBytes.slice(0, 32), 0);
    mutated.set(sHighBytes, 32);
    // Flip v byte for the high-s form
    mutated[64] = sigBytes[64] === 27 ? 28 : 27;
    expect(verifyECDSA(msg, bytesToHex(mutated), ADDR, CHAIN)).toBe(false);
  });

  it('never throws on malformed hex', () => {
    // Non-hex chars embedded — hexToBytes may throw; verifyECDSA catches.
    expect(
      verifyECDSA(msg, '0xnothexhex' as `0x${string}`, ADDR, CHAIN)
    ).toBe(false);
    expect(verifyECDSA(msg, '0x' as `0x${string}`, ADDR, CHAIN)).toBe(false);
  });

  it('recovers the sender from the digest (independent of signECDSAWithKey)', () => {
    // Build a signature manually via noble to prove the verifier is not
    // trivially reflecting the signer.
    const digest = hexToBytes(computeECDSADigest(msg, CHAIN));
    const sig = secp256k1.sign(digest, hexToBytes(PRIV));
    const out = new Uint8Array(65);
    out.set(sig.toCompactRawBytes());
    out[64] = sig.recovery + 27;
    expect(verifyECDSA(msg, bytesToHex(out), ADDR, CHAIN)).toBe(true);
  });
});
