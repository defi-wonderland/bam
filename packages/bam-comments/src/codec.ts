/**
 * App-opaque codec for the body bytes a bam-comments message carries
 * in its BAM `contents` field.
 *
 * Layout (the body IS `contents` — no per-message tag prefix; the
 * `contentTag` is bound by the BAM core via the batch-registration
 * event and the `messageHash` formula):
 *
 *   byte  0       : version (uint8) — 0x01
 *   byte  1       : kind    (uint8) — 0x00=comment, 0x01=reply
 *   bytes 2..34   : postIdHash (bytes32)
 *   bytes 34..42  : timestamp (uint64 BE, Unix seconds)
 *   [reply only]
 *   bytes 42..74  : parentMessageHash (bytes32)
 *   [both]
 *   bytes K..K+4  : contentLen (uint32 BE)
 *   bytes K+4..   : utf-8 content
 *
 * `K = 42` for `comment`, `K = 74` for `reply`.
 *
 * Both decode failures (truncation / bad version / bad utf-8) and
 * encode invariants (32-byte hashes, length bounds) throw — the
 * caller is the trust boundary.
 */

import { bytesToHex, hexToBytes } from './hex.js';

export const ENVELOPE_VERSION = 0x01;
export const KIND_COMMENT = 0x00;
export const KIND_REPLY = 0x01;

export type CommentEnvelope =
  | {
      kind: 'comment';
      postIdHash: `0x${string}`;
      timestamp: number;
      content: string;
    }
  | {
      kind: 'reply';
      postIdHash: `0x${string}`;
      timestamp: number;
      parentMessageHash: `0x${string}`;
      content: string;
    };

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });

/**
 * Encode a comment envelope into the body bytes the BAM `contents`
 * field carries.
 */
export function encodeCommentContents(msg: CommentEnvelope): Uint8Array {
  if (
    !Number.isInteger(msg.timestamp) ||
    msg.timestamp < 0 ||
    msg.timestamp > 0xffffffffffff
  ) {
    throw new RangeError(`timestamp out of range: ${msg.timestamp}`);
  }
  const postIdHash = hexToBytes(msg.postIdHash);
  if (postIdHash.length !== 32) {
    throw new RangeError(
      `postIdHash must be 32 bytes, got ${postIdHash.length}`
    );
  }
  const contentBytes = enc.encode(msg.content);
  if (contentBytes.length > 0xffffffff) {
    throw new RangeError('content too long');
  }

  if (msg.kind === 'comment') {
    const body = new Uint8Array(2 + 32 + 8 + 4 + contentBytes.length);
    body[0] = ENVELOPE_VERSION;
    body[1] = KIND_COMMENT;
    body.set(postIdHash, 2);
    writeU64BE(body, 34, BigInt(msg.timestamp));
    writeU32BE(body, 42, contentBytes.length);
    body.set(contentBytes, 46);
    return body;
  }

  // reply
  const parent = hexToBytes(msg.parentMessageHash);
  if (parent.length !== 32) {
    throw new RangeError(
      `parentMessageHash must be 32 bytes, got ${parent.length}`
    );
  }
  const body = new Uint8Array(2 + 32 + 8 + 32 + 4 + contentBytes.length);
  body[0] = ENVELOPE_VERSION;
  body[1] = KIND_REPLY;
  body.set(postIdHash, 2);
  writeU64BE(body, 34, BigInt(msg.timestamp));
  body.set(parent, 42);
  writeU32BE(body, 74, contentBytes.length);
  body.set(contentBytes, 78);
  return body;
}

/**
 * Inverse of `encodeCommentContents`. Throws on short buffer, unknown
 * version/kind, declared content length that overruns the payload, or
 * invalid UTF-8.
 */
export function decodeCommentContents(body: Uint8Array): CommentEnvelope {
  if (body.length < 2) {
    throw new RangeError('comments contents too short for envelope header');
  }
  const version = body[0];
  const kind = body[1];
  if (version !== ENVELOPE_VERSION) {
    throw new RangeError(`unsupported envelope version: ${version}`);
  }

  if (kind === KIND_COMMENT) {
    if (body.length < 46) {
      throw new RangeError('comment payload too short');
    }
    const postIdHash = bytesToHex(body.slice(2, 34));
    const timestamp = Number(readU64BE(body, 34));
    const contentLen = readU32BE(body, 42);
    if (46 + contentLen > body.length) {
      throw new RangeError('comment: content length runs past buffer');
    }
    const content = dec.decode(body.slice(46, 46 + contentLen));
    return { kind: 'comment', postIdHash, timestamp, content };
  }

  if (kind === KIND_REPLY) {
    if (body.length < 78) {
      throw new RangeError('reply payload too short');
    }
    const postIdHash = bytesToHex(body.slice(2, 34));
    const timestamp = Number(readU64BE(body, 34));
    const parentMessageHash = bytesToHex(body.slice(42, 74));
    const contentLen = readU32BE(body, 74);
    if (78 + contentLen > body.length) {
      throw new RangeError('reply: content length runs past buffer');
    }
    const content = dec.decode(body.slice(78, 78 + contentLen));
    return {
      kind: 'reply',
      postIdHash,
      timestamp,
      parentMessageHash,
      content,
    };
  }

  throw new RangeError(`unknown comments kind: ${kind}`);
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
