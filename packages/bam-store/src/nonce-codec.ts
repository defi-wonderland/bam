/**
 * Nonce codec — zero-padded 20-character decimal TEXT ↔ `bigint`.
 *
 * Max uint64 is 18446744073709551615 (20 digits). Zero-padding makes the
 * lexicographic ordering of the TEXT column match the numeric ordering of
 * the underlying integer, so `MAX()`, `ORDER BY`, and range queries work
 * without custom collation.
 *
 * This codec is the only place bigint↔text conversion happens; every DB
 * read/write goes through it so the width invariant holds everywhere.
 */

export const NONCE_TEXT_WIDTH = 20;
export const MIN_NONCE = 0n;
export const MAX_NONCE = (1n << 64n) - 1n; // 18446744073709551615

export class NonceCodecError extends Error {}

export function encodeNonce(nonce: bigint): string {
  if (nonce < MIN_NONCE || nonce > MAX_NONCE) {
    throw new NonceCodecError(`nonce out of uint64 range: ${nonce}`);
  }
  return nonce.toString().padStart(NONCE_TEXT_WIDTH, '0');
}

export function decodeNonce(text: string): bigint {
  if (text.length !== NONCE_TEXT_WIDTH) {
    throw new NonceCodecError(`nonce text has unexpected width ${text.length}`);
  }
  if (!/^[0-9]{20}$/.test(text)) {
    throw new NonceCodecError(`nonce text is not 20 decimal digits: ${text}`);
  }
  const n = BigInt(text);
  if (n > MAX_NONCE) {
    throw new NonceCodecError(`nonce text exceeds uint64 max: ${text}`);
  }
  return n;
}
