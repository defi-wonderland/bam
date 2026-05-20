import { describe, expect, it } from 'vitest';

import type { Bytes32 } from '../../src/types.js';
import {
  deriveBLSPublicKey,
  signBLS,
  verifyBLS,
} from '../../src/signatures.js';

/**
 * BLS sign/verify smoke pin.
 *
 * Before the tag-binding rework, `signBLS` and `verifyBLS` were
 * passing a `0x`-prefixed hex string into `@noble/bls12-381`, which
 * expects raw bytes — they would throw at runtime with "Invalid byte
 * sequence" on the first real call. The bug was caught only because
 * the cross-tag-replay test exercised BLS for the first time. This
 * file is a cheap regression check so a future change can't silently
 * break the BLS path again.
 *
 * BLS signatures are deterministic in the min-pubkey variant the SDK
 * uses, so we lock concrete bytes for a fixed `(priv, messageHash)`.
 * Update both `EXPECTED_PUB` and `EXPECTED_SIG` together if the
 * underlying scheme parameters intentionally change.
 */

function hexToBytes(hex: string): Uint8Array {
  const c = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(c.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(c.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(b: Uint8Array): string {
  return '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

const PRIV = hexToBytes('0x' + '11'.repeat(32));
const HASH = ('0x' + 'cc'.repeat(32)) as Bytes32;
const EXPECTED_PUB =
  '0x97248533cef0908a5ebe52c3b487471301bf6369010e6167f63dd74feddac2dfb5336a59a331d38eb0e454d6f6fcb1a4';
const EXPECTED_SIG =
  '0xa78721ad70d968f2289006f76bdaaad80970c4ac7eaa38d0539a279911d30a650755de85c285fc3a505332aee5becea817716b5e2608fcf8020315c9e77fd9a8791d088e5ed24becb72c98ee5d4c9c29bca9e71be8170461695a2db9143ad06d';

describe('BLS sign/verify smoke', () => {
  it('signBLS returns a non-empty 96-byte signature (catches hex-vs-bytes regression)', async () => {
    const sig = await signBLS(PRIV, HASH);
    expect(sig).toBeInstanceOf(Uint8Array);
    expect(sig.length).toBe(96);
  });

  it('signBLS is deterministic against the locked reference', async () => {
    const sig = await signBLS(PRIV, HASH);
    expect(bytesToHex(sig)).toBe(EXPECTED_SIG);
  });

  it('deriveBLSPublicKey matches the locked reference', () => {
    const pub = deriveBLSPublicKey(PRIV);
    expect(bytesToHex(pub)).toBe(EXPECTED_PUB);
  });

  it('verifyBLS accepts the matching signature and rejects a wrong hash', async () => {
    const sig = await signBLS(PRIV, HASH);
    const pub = deriveBLSPublicKey(PRIV);
    expect(await verifyBLS(pub, HASH, sig)).toBe(true);
    const wrong = ('0x' + 'dd'.repeat(32)) as Bytes32;
    expect(await verifyBLS(pub, wrong, sig)).toBe(false);
  });

  it('signBLS rejects a non-32-byte messageHash with a clear error', async () => {
    // `Bytes32` is just `0x${string}` — the type checker does not
    // enforce length. A caller could accidentally hand a 2-byte or
    // 64-byte hex string; the SDK MUST refuse, otherwise the BLS
    // signature would never interoperate with on-chain `bytes32`
    // registries.
    const tooShort = '0xabcd' as Bytes32;
    await expect(signBLS(PRIV, tooShort)).rejects.toThrow(/32 bytes/);

    const tooLong = ('0x' + 'aa'.repeat(33)) as Bytes32;
    await expect(signBLS(PRIV, tooLong)).rejects.toThrow(/32 bytes/);
  });

  it('verifyBLS returns false on a non-32-byte messageHash (consistent with bad-signature path)', async () => {
    const sig = await signBLS(PRIV, HASH);
    const pub = deriveBLSPublicKey(PRIV);
    expect(await verifyBLS(pub, '0xabcd' as Bytes32, sig)).toBe(false);
    expect(await verifyBLS(pub, ('0x' + 'aa'.repeat(33)) as Bytes32, sig)).toBe(false);
  });
});
