/**
 * Tiny hex helpers reused across the widget. Local copy (not imported
 * from `bam-sdk`) so importing `bam-sdk/browser` doesn't pull in any
 * additional surface area beyond what we strictly need
 * (`splitContents`, `encodeContents`, EIP-712 helpers).
 */

export function hexToBytes(hex: string): Uint8Array {
  const c = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (c.length % 2 !== 0) {
    throw new RangeError('hex string must have even length');
  }
  if (!/^[0-9a-fA-F]*$/.test(c)) {
    throw new RangeError('hex string contains non-hex characters');
  }
  const out = new Uint8Array(c.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(c.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): `0x${string}` {
  let s = '0x';
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, '0');
  }
  return s as `0x${string}`;
}
