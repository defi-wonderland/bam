/**
 * Forum codec for the BAM Forum demo. Three message kinds (`post`,
 * `reply`, `like`) share the single outer `contentTag` `FORUM_TAG`;
 * the kind byte inside `contents` discriminates. The body IS
 * `contents` — `contentTag` is bound externally by the BAM core via
 * the batch-registration event and the ERC-8180 `messageHash`
 * formula, so the codec does not carry the tag.
 *
 * Layout (inside `contents`):
 *   byte 0 : version (uint8)
 *   byte 1 : kind    (uint8) — 0=post, 1=reply, 2=like
 *   bytes 2.. : kind-specific payload
 *
 * Per-kind payloads:
 *   post (version 0x02, kind 0x00):
 *     bytes  0..8  : uint64 BE timestamp (Unix epoch seconds)
 *     byte   8     : uint8 tagLen (≤ 32) — inner freetext tag
 *     bytes  9..   : tag (UTF-8, tagLen bytes)
 *     uint32 BE titleLen, title (UTF-8)
 *     uint32 BE bodyLen,  body  (UTF-8)
 *   reply (version 0x01, kind 0x01):
 *     bytes  0..8  : uint64 BE timestamp
 *     bytes  8..40 : bytes32 parentMessageHash (ERC-8180 messageHash)
 *     uint32 BE bodyLen, body (UTF-8)
 *   like (version 0x01, kind 0x02):
 *     bytes  0..8  : uint64 BE timestamp
 *     bytes  8..40 : bytes32 targetMessageHash
 *     (fixed 42 bytes total)
 *
 * `FORUM_TAG = keccak256("bam-forum-demo.v1")`.
 */

import { keccak_256 } from '@noble/hashes/sha3';

import { bytesToHex, hexToBytes } from '../message.js';
import type { Bytes32 } from '../types.js';

const KIND_POST = 0x00;
const KIND_REPLY = 0x01;
const KIND_LIKE = 0x02;

const VERSION_POST = 0x02;
const VERSION_REPLY = 0x01;
const VERSION_LIKE = 0x01;

const MAX_TAG_LEN = 32;

export const FORUM_TAG: Bytes32 = bytesToHex(
  keccak_256(new TextEncoder().encode('bam-forum-demo.v1'))
) as Bytes32;

export interface ForumPost {
  kind: 0x00;
  version: 0x02;
  timestamp: bigint;
  tag: Uint8Array;
  title: string;
  body: string;
}

export interface ForumReply {
  kind: 0x01;
  version: 0x01;
  timestamp: bigint;
  parentMessageHash: Bytes32;
  body: string;
}

export interface ForumLike {
  kind: 0x02;
  version: 0x01;
  timestamp: bigint;
  targetMessageHash: Bytes32;
}

export type ForumPayload = ForumPost | ForumReply | ForumLike;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

export function encodeForumContents(payload: ForumPayload): Uint8Array {
  if (payload.timestamp < 0n || payload.timestamp > 0xffffffffffffffffn) {
    throw new RangeError(`timestamp out of uint64 range: ${payload.timestamp}`);
  }

  if (payload.kind === KIND_POST) {
    if (payload.tag.length > MAX_TAG_LEN) {
      throw new RangeError('tag exceeds 32 bytes');
    }
    const titleBytes = textEncoder.encode(payload.title);
    const bodyBytes = textEncoder.encode(payload.body);
    if (titleBytes.length > 0xffffffff) {
      throw new RangeError('title too long');
    }
    if (bodyBytes.length > 0xffffffff) {
      throw new RangeError('body too long');
    }

    const buf = new Uint8Array(
      2 + 8 + 1 + payload.tag.length + 4 + titleBytes.length + 4 + bodyBytes.length
    );
    let o = 0;
    buf[o++] = VERSION_POST;
    buf[o++] = KIND_POST;
    writeU64BE(buf, o, payload.timestamp);
    o += 8;
    buf[o++] = payload.tag.length;
    buf.set(payload.tag, o);
    o += payload.tag.length;
    writeU32BE(buf, o, titleBytes.length);
    o += 4;
    buf.set(titleBytes, o);
    o += titleBytes.length;
    writeU32BE(buf, o, bodyBytes.length);
    o += 4;
    buf.set(bodyBytes, o);
    return buf;
  }

  if (payload.kind === KIND_REPLY) {
    const parent = hexToBytes(payload.parentMessageHash);
    if (parent.length !== 32) {
      throw new RangeError('parentMessageHash must be 32 bytes');
    }
    const bodyBytes = textEncoder.encode(payload.body);
    if (bodyBytes.length > 0xffffffff) {
      throw new RangeError('body too long');
    }

    const buf = new Uint8Array(2 + 8 + 32 + 4 + bodyBytes.length);
    buf[0] = VERSION_REPLY;
    buf[1] = KIND_REPLY;
    writeU64BE(buf, 2, payload.timestamp);
    buf.set(parent, 10);
    writeU32BE(buf, 42, bodyBytes.length);
    buf.set(bodyBytes, 46);
    return buf;
  }

  if (payload.kind === KIND_LIKE) {
    const target = hexToBytes(payload.targetMessageHash);
    if (target.length !== 32) {
      throw new RangeError('targetMessageHash must be 32 bytes');
    }
    const buf = new Uint8Array(2 + 8 + 32);
    buf[0] = VERSION_LIKE;
    buf[1] = KIND_LIKE;
    writeU64BE(buf, 2, payload.timestamp);
    buf.set(target, 10);
    return buf;
  }

  // Exhaustiveness guard for unknown kinds at the type level.
  throw new RangeError(
    `unknown forum kind: ${(payload as { kind: number }).kind}`
  );
}

/**
 * Inverse of `encodeForumContents`. Throws on short buffer, unknown
 * (version, kind), length-prefix that overruns the payload, or
 * invalid UTF-8.
 */
export function decodeForumContents(bytes: Uint8Array): ForumPayload {
  if (bytes.length < 2) {
    throw new RangeError('forum contents too short for envelope header');
  }
  const version = bytes[0];
  const kind = bytes[1];

  if (version === VERSION_POST && kind === KIND_POST) {
    if (bytes.length < 2 + 8 + 1) {
      throw new RangeError('post payload too short');
    }
    const timestamp = readU64BE(bytes, 2);
    const tagLen = bytes[10];
    if (tagLen > MAX_TAG_LEN) {
      throw new RangeError('tag exceeds 32 bytes');
    }
    let o = 11;
    if (o + tagLen > bytes.length) {
      throw new RangeError('post: tag runs past buffer');
    }
    const tag = bytes.slice(o, o + tagLen);
    o += tagLen;
    if (o + 4 > bytes.length) {
      throw new RangeError('post: missing title length');
    }
    const titleLen = readU32BE(bytes, o);
    o += 4;
    if (o + titleLen > bytes.length) {
      throw new RangeError('post: title runs past buffer');
    }
    const title = textDecoder.decode(bytes.slice(o, o + titleLen));
    o += titleLen;
    if (o + 4 > bytes.length) {
      throw new RangeError('post: missing body length');
    }
    const bodyLen = readU32BE(bytes, o);
    o += 4;
    if (o + bodyLen > bytes.length) {
      throw new RangeError('post: body runs past buffer');
    }
    const body = textDecoder.decode(bytes.slice(o, o + bodyLen));
    return {
      kind: KIND_POST,
      version: VERSION_POST,
      timestamp,
      tag,
      title,
      body,
    };
  }

  if (version === VERSION_REPLY && kind === KIND_REPLY) {
    if (bytes.length < 46) {
      throw new RangeError('reply payload too short');
    }
    const timestamp = readU64BE(bytes, 2);
    const parentMessageHash = bytesToHex(bytes.slice(10, 42)) as Bytes32;
    const bodyLen = readU32BE(bytes, 42);
    if (46 + bodyLen > bytes.length) {
      throw new RangeError('reply: body runs past buffer');
    }
    const body = textDecoder.decode(bytes.slice(46, 46 + bodyLen));
    return {
      kind: KIND_REPLY,
      version: VERSION_REPLY,
      timestamp,
      parentMessageHash,
      body,
    };
  }

  if (version === VERSION_LIKE && kind === KIND_LIKE) {
    if (bytes.length < 42) {
      throw new RangeError('like payload too short');
    }
    const timestamp = readU64BE(bytes, 2);
    const targetMessageHash = bytesToHex(bytes.slice(10, 42)) as Bytes32;
    return {
      kind: KIND_LIKE,
      version: VERSION_LIKE,
      timestamp,
      targetMessageHash,
    };
  }

  throw new RangeError(`unsupported forum (version, kind): (${version}, ${kind})`);
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
