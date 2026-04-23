/**
 * SDK local-verify helpers — same happy / negative matrix as T004/T005
 * Forge tests, run against the SDK helpers only (no on-chain calls).
 *
 * The anvil-backed differential test in T013 asserts that SDK and contract
 * agree byte-for-byte on identical inputs (red-team C-9).
 */

import { describe, expect, it } from 'vitest';
import { keccak256 as viemKeccak256 } from 'viem';
import * as secp from '@noble/secp256k1';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';

import {
  deriveAddress,
  verifyEcdsaAsEOA,
  verifyEcdsaLocal,
  wrapPersonalSign,
} from '../../src/signatures.js';
import type { Address, HexBytes } from '../../src/types.js';

secp.etc.hmacSha256Sync = (k: Uint8Array, ...m: Uint8Array[]) =>
  hmac(sha256, k, secp.etc.concatBytes(...m));

const SECP256K1_N = secp.CURVE.n;

function newKey(seed: string): { priv: string; address: Address } {
  // Deterministic scalar ≤ n-1 from a label.
  const seedBytes = new TextEncoder().encode(seed);
  const h = viemKeccak256(seedBytes).slice(2);
  const priv = '0x' + h;
  const address = deriveAddress(priv);
  return { priv, address };
}

function privBytes(priv: string): Uint8Array {
  const cleaned = priv.startsWith('0x') ? priv.slice(2) : priv;
  return Uint8Array.from(Buffer.from(cleaned, 'hex'));
}

function signRaw(priv: string, hash: HexBytes): { sig: Uint8Array; v: number; r: Uint8Array; s: Uint8Array } {
  const msg = Uint8Array.from(Buffer.from(hash.slice(2), 'hex'));
  const sig = secp.sign(msg, privBytes(priv));
  const compact = sig.toCompactRawBytes();
  const v = sig.recovery + 27;
  const out = new Uint8Array(65);
  out.set(compact, 0);
  out[64] = v;
  return {
    sig: out,
    v,
    r: compact.slice(0, 32),
    s: compact.slice(32, 64),
  };
}

function bigintTo32(value: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = value;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

describe('verifyEcdsaLocal', () => {
  const owner = newKey('alice');
  const delegate = newKey('alice-delegate');
  const bob = newKey('bob');
  const raw: HexBytes = viemKeccak256('0xdeadbeef') as HexBytes;
  const envelope: HexBytes = wrapPersonalSign(raw);

  it('keyless: returns true for owner-signed signature', () => {
    const { sig } = signRaw(owner.priv, envelope);
    expect(verifyEcdsaLocal({ owner: owner.address, hash: envelope, signature: sig })).toBe(true);
  });

  it('keyless: returns false for signature from a different EOA', () => {
    const { sig } = signRaw(bob.priv, envelope);
    expect(verifyEcdsaLocal({ owner: owner.address, hash: envelope, signature: sig })).toBe(false);
  });

  it('keyed: returns true when recovered signer matches the bound delegate', () => {
    const { sig } = signRaw(delegate.priv, envelope);
    expect(
      verifyEcdsaLocal({
        owner: owner.address,
        hash: envelope,
        signature: sig,
        delegate: delegate.address,
      })
    ).toBe(true);
  });

  it("keyed: returns false for the owner's own EOA signature once delegated", () => {
    const { sig } = signRaw(owner.priv, envelope);
    expect(
      verifyEcdsaLocal({
        owner: owner.address,
        hash: envelope,
        signature: sig,
        delegate: delegate.address,
      })
    ).toBe(false);
  });

  it('returns false for a high-s malleated signature', () => {
    const { r, s, v } = signRaw(owner.priv, envelope);
    const sBig = BigInt('0x' + Buffer.from(s).toString('hex'));
    const malS = SECP256K1_N - sBig;
    const malV = v === 27 ? 28 : 27;
    const malSig = new Uint8Array(65);
    malSig.set(r, 0);
    malSig.set(bigintTo32(malS), 32);
    malSig[64] = malV;
    expect(verifyEcdsaLocal({ owner: owner.address, hash: envelope, signature: malSig })).toBe(
      false
    );
  });

  it('returns false for non-canonical v values', () => {
    const { r, s } = signRaw(owner.priv, envelope);
    for (const bad of [0, 1, 29, 35]) {
      const badSig = new Uint8Array(65);
      badSig.set(r, 0);
      badSig.set(s, 32);
      badSig[64] = bad;
      expect(verifyEcdsaLocal({ owner: owner.address, hash: envelope, signature: badSig })).toBe(
        false
      );
    }
  });

  it('returns false for malformed signature length', () => {
    const short = new Uint8Array(32);
    expect(verifyEcdsaLocal({ owner: owner.address, hash: envelope, signature: short })).toBe(
      false
    );
  });

  it('returns false for owner=0x0 + garbage sig (C-2)', () => {
    const garbage = new Uint8Array(65);
    garbage[64] = 27;
    expect(
      verifyEcdsaLocal({
        owner: '0x0000000000000000000000000000000000000000',
        hash: envelope,
        signature: garbage,
      })
    ).toBe(false);
  });
});

describe('verifyEcdsaAsEOA', () => {
  const owner = newKey('alice-eoa-path');
  const delegate = newKey('alice-delegate-eoa-path');
  const raw: HexBytes = viemKeccak256('0xc0ffee') as HexBytes;
  const envelope: HexBytes = wrapPersonalSign(raw);

  it('accepts signatures from the owner EOA even after delegation', () => {
    const { sig } = signRaw(owner.priv, envelope);
    expect(verifyEcdsaAsEOA({ owner: owner.address, hash: envelope, signature: sig })).toBe(true);
  });

  it('rejects a delegate-signed sig — this path is EOA-only by design', () => {
    const { sig } = signRaw(delegate.priv, envelope);
    expect(verifyEcdsaAsEOA({ owner: owner.address, hash: envelope, signature: sig })).toBe(false);
  });

  it('rejects owner=0x0 regardless of signature', () => {
    const { sig } = signRaw(owner.priv, envelope);
    expect(
      verifyEcdsaAsEOA({
        owner: '0x0000000000000000000000000000000000000000',
        hash: envelope,
        signature: sig,
      })
    ).toBe(false);
  });
});
