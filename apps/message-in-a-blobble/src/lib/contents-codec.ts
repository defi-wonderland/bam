/**
 * message-in-a-blobble's codec for the body bytes the BAM `contents`
 * field carries. The demo owns its own serialization of
 * `{ timestamp, content }`.
 *
 * After the tag-binding rework, body IS `contents` — no 32-byte tag
 * prefix; `contentTag` is bound by the BAM core via the
 * batch-registration event and the `messageHash` formula.
 *
 * Single source of truth: imported by `MessageComposer`, `MessageList`,
 * and `api/sync/route.ts`. Any divergence between them would render
 * messages incorrectly with no protocol-level signal, so exactly one
 * module owns the codec.
 *
 * Layout:
 *   bytes  0..8  : uint64 BE timestamp (Unix epoch seconds)
 *   bytes  8..12 : uint32 BE UTF-8 content length
 *   bytes 12..   : UTF-8 content bytes
 */

export interface SocialMessage {
  timestamp: number;
  content: string;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

/**
 * Encode a Social message as a BAM `contents` byte string. Throws
 * RangeError on out-of-bound timestamp or content > 4 GiB (far above
 * any realistic app cap).
 */
export function encodeSocialContents(app: SocialMessage): Uint8Array {
  if (!Number.isInteger(app.timestamp) || app.timestamp < 0 || app.timestamp > 0xffffffffffff) {
    throw new RangeError(`timestamp out of range: ${app.timestamp}`);
  }
  const contentBytes = textEncoder.encode(app.content);
  if (contentBytes.length > 0xffffffff) {
    throw new RangeError('content too long');
  }
  const body = new Uint8Array(8 + 4 + contentBytes.length);
  writeU64BE(body, 0, BigInt(app.timestamp));
  writeU32BE(body, 8, contentBytes.length);
  body.set(contentBytes, 12);
  return body;
}

/**
 * Inverse of `encodeSocialContents`. Throws on a short buffer, a
 * declared content length that overruns the payload, or invalid UTF-8.
 */
export function decodeSocialContents(body: Uint8Array): SocialMessage {
  if (body.length < 12) {
    throw new RangeError('social contents too short');
  }
  const timestamp = Number(readU64BE(body, 0));
  const contentLen = readU32BE(body, 8);
  if (12 + contentLen > body.length) {
    throw new RangeError('social contents: content length runs past buffer');
  }
  const content = textDecoder.decode(body.slice(12, 12 + contentLen));
  return { timestamp, content };
}

function writeU32BE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = (value >>> 24) & 0xff;
  buf[offset + 1] = (value >>> 16) & 0xff;
  buf[offset + 2] = (value >>> 8) & 0xff;
  buf[offset + 3] = value & 0xff;
}
function readU32BE(buf: Uint8Array, offset: number): number {
  return (
    buf[offset] * 0x1000000 +
    (buf[offset + 1] << 16) +
    (buf[offset + 2] << 8) +
    buf[offset + 3]
  );
}
function writeU64BE(buf: Uint8Array, offset: number, value: bigint): void {
  for (let i = 7; i >= 0; i--) {
    buf[offset + i] = Number(value & 0xffn);
    value >>= 8n;
  }
}
function readU64BE(buf: Uint8Array, offset: number): bigint {
  let v = 0n;
  for (let i = 0; i < 8; i++) {
    v = (v << 8n) | BigInt(buf[offset + i]);
  }
  return v;
}
