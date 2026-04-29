/**
 * bam-twitter's app-opaque codec for the bytes after the 32-byte
 * contentTag prefix. Multiple message kinds (post, reply) share the
 * same contentTag and one feed; the kind byte discriminates.
 *
 * Layout inside `contents[32:]` (`appBytes`):
 *   byte  0       : version (uint8) — currently 0x01
 *   byte  1       : kind    (uint8) — 0=post, 1=reply
 *   bytes 2..     : kind-specific payload
 *
 * Per-kind payloads:
 *   post:
 *     bytes  0..8  : uint64 BE timestamp (Unix epoch seconds)
 *     bytes  8..12 : uint32 BE UTF-8 content length
 *     bytes 12..   : UTF-8 content
 *   reply:
 *     bytes  0..8  : uint64 BE timestamp (Unix epoch seconds)
 *     bytes  8..40 : bytes32 parentMessageHash (ERC-8180 messageHash)
 *     bytes 40..44 : uint32 BE UTF-8 content length
 *     bytes 44..   : UTF-8 content
 *
 * The 32-byte contentTag prefix is added by `encodeContents` in
 * bam-sdk; this module produces / consumes only the app-opaque
 * portion. Single source of truth for both Composer and Timeline.
 */

import { encodeContents, splitContents, type Bytes32 } from 'bam-sdk/browser';

const ENVELOPE_VERSION = 0x01;
const KIND_POST = 0x00;
const KIND_REPLY = 0x01;

export type TwitterMessage =
  | { kind: 'post'; timestamp: number; content: string }
  | {
      kind: 'reply';
      timestamp: number;
      parentMessageHash: Bytes32;
      content: string;
    };

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

export function encodeTwitterContents(
  contentTag: Bytes32,
  msg: TwitterMessage
): Uint8Array {
  if (
    !Number.isInteger(msg.timestamp) ||
    msg.timestamp < 0 ||
    msg.timestamp > 0xffffffffffff
  ) {
    throw new RangeError(`timestamp out of range: ${msg.timestamp}`);
  }
  const contentBytes = textEncoder.encode(msg.content);
  if (contentBytes.length > 0xffffffff) {
    throw new RangeError('content too long');
  }

  if (msg.kind === 'post') {
    const body = new Uint8Array(2 + 8 + 4 + contentBytes.length);
    body[0] = ENVELOPE_VERSION;
    body[1] = KIND_POST;
    writeU64BE(body, 2, BigInt(msg.timestamp));
    writeU32BE(body, 10, contentBytes.length);
    body.set(contentBytes, 14);
    return encodeContents(contentTag, body);
  }

  // reply
  const parent = hexToBytes(msg.parentMessageHash);
  if (parent.length !== 32) {
    throw new RangeError('parentMessageHash must be 32 bytes');
  }
  const body = new Uint8Array(2 + 8 + 32 + 4 + contentBytes.length);
  body[0] = ENVELOPE_VERSION;
  body[1] = KIND_REPLY;
  writeU64BE(body, 2, BigInt(msg.timestamp));
  body.set(parent, 10);
  writeU32BE(body, 42, contentBytes.length);
  body.set(contentBytes, 46);
  return encodeContents(contentTag, body);
}

/**
 * Inverse of `encodeTwitterContents`. Throws on short buffer, unknown
 * version/kind, declared content length that overruns the payload, or
 * invalid UTF-8.
 */
export function decodeTwitterContents(contents: Uint8Array): {
  contentTag: Bytes32;
  app: TwitterMessage;
} {
  const { contentTag, appBytes } = splitContents(contents);
  if (appBytes.length < 2) {
    throw new RangeError('twitter contents too short for envelope header');
  }
  const version = appBytes[0];
  const kind = appBytes[1];
  if (version !== ENVELOPE_VERSION) {
    throw new RangeError(`unsupported envelope version: ${version}`);
  }

  if (kind === KIND_POST) {
    if (appBytes.length < 14) {
      throw new RangeError('post payload too short');
    }
    const timestamp = Number(readU64BE(appBytes, 2));
    const contentLen = readU32BE(appBytes, 10);
    if (14 + contentLen > appBytes.length) {
      throw new RangeError('post: content length runs past buffer');
    }
    const content = textDecoder.decode(appBytes.slice(14, 14 + contentLen));
    return { contentTag, app: { kind: 'post', timestamp, content } };
  }

  if (kind === KIND_REPLY) {
    if (appBytes.length < 46) {
      throw new RangeError('reply payload too short');
    }
    const timestamp = Number(readU64BE(appBytes, 2));
    const parentMessageHash = bytesToHex(appBytes.slice(10, 42)) as Bytes32;
    const contentLen = readU32BE(appBytes, 42);
    if (46 + contentLen > appBytes.length) {
      throw new RangeError('reply: content length runs past buffer');
    }
    const content = textDecoder.decode(appBytes.slice(46, 46 + contentLen));
    return {
      contentTag,
      app: { kind: 'reply', timestamp, parentMessageHash, content },
    };
  }

  throw new RangeError(`unknown twitter kind: ${kind}`);
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
function hexToBytes(hex: string): Uint8Array {
  const c = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (c.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(c)) {
    throw new RangeError('invalid hex');
  }
  const out = new Uint8Array(c.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(c.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
function bytesToHex(b: Uint8Array): string {
  return (
    '0x' +
    Array.from(b)
      .map((x) => x.toString(16).padStart(2, '0'))
      .join('')
  );
}
