/**
 * message-in-a-blobble's codec for the app-opaque portion of a BAM
 * message's `contents` — the demo owns its own serialization of
 * `{ timestamp, content }` into `contents[32:]`.
 *
 * Single source of truth: imported by `MessageComposer`, `MessageList`,
 * and `api/sync/route.ts`. Any divergence between them would render
 * messages incorrectly with no protocol-level signal, so exactly one
 * module owns the codec.
 *
 * Layout (inside `contents[32:]`):
 *   bytes  0..8  : uint64 BE timestamp (Unix epoch seconds)
 *   bytes  8..12 : uint32 BE UTF-8 content length
 *   bytes 12..   : UTF-8 content bytes
 *
 * The 32-byte contentTag prefix is added by `encodeContents` in
 * `bam-sdk`; this module produces / consumes only the app-opaque
 * portion.
 */

import { encodeContents, splitContents, type Bytes32 } from 'bam-sdk/browser';

export interface SocialMessage {
  timestamp: number;
  content: string;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

/**
 * Encode a Social message as a BAM `contents` byte string with the
 * given `contentTag` prefix. Throws RangeError on out-of-bound
 * timestamp or content > 4 GiB (far above any realistic app cap).
 */
export function encodeSocialContents(
  contentTag: Bytes32,
  app: SocialMessage
): Uint8Array {
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
  return encodeContents(contentTag, body);
}

/**
 * Inverse of `encodeSocialContents`. Returns the `contentTag` prefix
 * and the decoded app fields. Throws on a short buffer, a declared
 * content length that overruns the payload, or invalid UTF-8.
 */
export function decodeSocialContents(contents: Uint8Array): {
  contentTag: Bytes32;
  app: SocialMessage;
} {
  const { contentTag, appBytes } = splitContents(contents);
  if (appBytes.length < 12) {
    throw new RangeError('social contents too short');
  }
  const timestamp = Number(readU64BE(appBytes, 0));
  const contentLen = readU32BE(appBytes, 8);
  if (12 + contentLen > appBytes.length) {
    throw new RangeError('social contents: content length runs past buffer');
  }
  const content = textDecoder.decode(appBytes.slice(12, 12 + contentLen));
  return { contentTag, app: { timestamp, content } };
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
