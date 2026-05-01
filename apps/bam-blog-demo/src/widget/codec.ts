/**
 * App-opaque codec for `contents[32:]` — the bytes after the
 * 32-byte ERC-8179 contentTag prefix. Modelled on
 * `apps/bam-twitter/src/lib/contents-codec.ts` with one extension:
 * every payload carries a `postIdHash` (bytes32) immediately after
 * the kind byte, so the same `contentTag` can carry comments for
 * many posts and a relay cannot re-attribute a signed comment to
 * a different post (flipping `postIdHash` invalidates `messageHash`).
 *
 * Layout of the bytes after the 32-byte contentTag prefix
 * (`appBytes`):
 *
 *   byte  0      : version    (uint8) — currently 0x01
 *   byte  1      : kind       (uint8) — 0=comment, 1=reply
 *   bytes 2..34  : postIdHash (bytes32) — keccak256("bam-blog-demo.v1:" + slug)
 *   bytes 34..42 : timestamp  (uint64 BE, Unix seconds)
 *   [reply only]
 *   bytes 42..74 : parentMessageHash (bytes32) — ERC-8180 messageHash
 *   [both kinds]
 *   bytes K..K+4 : contentLen (uint32 BE)
 *   bytes K+4..  : UTF-8 content
 *
 * `K = 42` for `comment`, `K = 74` for `reply`. Same source-of-truth
 * pattern as bam-twitter: this module is the only place that
 * encodes or decodes the app-opaque payload, and a round-trip +
 * negative test suite pins it.
 */

import { encodeContents, splitContents, type Bytes32 } from 'bam-sdk/browser';

const ENVELOPE_VERSION = 0x01;
const KIND_COMMENT = 0x00;
const KIND_REPLY = 0x01;

export type BlogMessage =
  | {
      kind: 'comment';
      postIdHash: Bytes32;
      timestamp: number;
      content: string;
    }
  | {
      kind: 'reply';
      postIdHash: Bytes32;
      timestamp: number;
      parentMessageHash: Bytes32;
      content: string;
    };

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

export function encodeBlogContents(
  contentTag: Bytes32,
  msg: BlogMessage
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
  const postId = hexToBytes(msg.postIdHash);
  if (postId.length !== 32) {
    throw new RangeError('postIdHash must be 32 bytes');
  }

  if (msg.kind === 'comment') {
    const body = new Uint8Array(2 + 32 + 8 + 4 + contentBytes.length);
    body[0] = ENVELOPE_VERSION;
    body[1] = KIND_COMMENT;
    body.set(postId, 2);
    writeU64BE(body, 34, BigInt(msg.timestamp));
    writeU32BE(body, 42, contentBytes.length);
    body.set(contentBytes, 46);
    return encodeContents(contentTag, body);
  }

  // reply
  const parent = hexToBytes(msg.parentMessageHash);
  if (parent.length !== 32) {
    throw new RangeError('parentMessageHash must be 32 bytes');
  }
  const body = new Uint8Array(2 + 32 + 8 + 32 + 4 + contentBytes.length);
  body[0] = ENVELOPE_VERSION;
  body[1] = KIND_REPLY;
  body.set(postId, 2);
  writeU64BE(body, 34, BigInt(msg.timestamp));
  body.set(parent, 42);
  writeU32BE(body, 74, contentBytes.length);
  body.set(contentBytes, 78);
  return encodeContents(contentTag, body);
}

/**
 * Inverse of `encodeBlogContents`. Throws on short buffer, unknown
 * version/kind, declared content length that overruns the payload, or
 * invalid UTF-8.
 */
export function decodeBlogContents(contents: Uint8Array): {
  contentTag: Bytes32;
  app: BlogMessage;
} {
  const { contentTag, appBytes } = splitContents(contents);
  if (appBytes.length < 2) {
    throw new RangeError('blog contents too short for envelope header');
  }
  const version = appBytes[0];
  const kind = appBytes[1];
  if (version !== ENVELOPE_VERSION) {
    throw new RangeError(`unsupported envelope version: ${version}`);
  }

  if (kind === KIND_COMMENT) {
    if (appBytes.length < 46) {
      throw new RangeError('comment payload too short');
    }
    const postIdHash = bytesToHex(appBytes.slice(2, 34)) as Bytes32;
    const timestamp = Number(readU64BE(appBytes, 34));
    const contentLen = readU32BE(appBytes, 42);
    if (46 + contentLen > appBytes.length) {
      throw new RangeError('comment: content length runs past buffer');
    }
    const content = textDecoder.decode(appBytes.slice(46, 46 + contentLen));
    return {
      contentTag,
      app: { kind: 'comment', postIdHash, timestamp, content },
    };
  }

  if (kind === KIND_REPLY) {
    if (appBytes.length < 78) {
      throw new RangeError('reply payload too short');
    }
    const postIdHash = bytesToHex(appBytes.slice(2, 34)) as Bytes32;
    const timestamp = Number(readU64BE(appBytes, 34));
    const parentMessageHash = bytesToHex(appBytes.slice(42, 74)) as Bytes32;
    const contentLen = readU32BE(appBytes, 74);
    if (78 + contentLen > appBytes.length) {
      throw new RangeError('reply: content length runs past buffer');
    }
    const content = textDecoder.decode(appBytes.slice(78, 78 + contentLen));
    return {
      contentTag,
      app: { kind: 'reply', postIdHash, timestamp, parentMessageHash, content },
    };
  }

  throw new RangeError(`unknown blog kind: ${kind}`);
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
