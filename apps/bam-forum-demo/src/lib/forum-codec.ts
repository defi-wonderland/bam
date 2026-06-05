import { computeMessageHash } from 'bam-sdk/browser';
import type { Address, Bytes32 } from 'bam-sdk/browser';

export const FORUM_CONTENT_TAG_STRING = 'bam-forum-demo.v1';

export const FORUM_KIND_POST = 0x00;
export const FORUM_KIND_REPLY = 0x01;

export type ForumPost = {
  kind: typeof FORUM_KIND_POST;
  timestamp: bigint;
  title: string;
  body: string;
};

export type ForumReply = {
  kind: typeof FORUM_KIND_REPLY;
  timestamp: bigint;
  parentMessageHash: Bytes32;
  body: string;
};

export type ForumPayload = ForumPost | ForumReply;

const enc = new TextEncoder();
const dec = new TextDecoder();

function writeBigUint64BE(buf: Uint8Array, offset: number, value: bigint) {
  const view = new DataView(buf.buffer, buf.byteOffset);
  view.setBigUint64(offset, value, false);
}

function writeUint32BE(buf: Uint8Array, offset: number, value: number) {
  const view = new DataView(buf.buffer, buf.byteOffset);
  view.setUint32(offset, value, false);
}

function readBigUint64BE(buf: Uint8Array, offset: number): bigint {
  return new DataView(buf.buffer, buf.byteOffset).getBigUint64(offset, false);
}

function readUint32BE(buf: Uint8Array, offset: number): number {
  return new DataView(buf.buffer, buf.byteOffset).getUint32(offset, false);
}

export function encodeForumPayload(payload: ForumPayload): Uint8Array {
  if (payload.kind === FORUM_KIND_POST) {
    const titleBytes = enc.encode(payload.title);
    const bodyBytes = enc.encode(payload.body);
    // version(1) + kind(1) + ts(8) + titleLen(4) + title + bodyLen(4) + body
    const buf = new Uint8Array(1 + 1 + 8 + 4 + titleBytes.length + 4 + bodyBytes.length);
    buf[0] = 0x01;
    buf[1] = FORUM_KIND_POST;
    writeBigUint64BE(buf, 2, payload.timestamp);
    writeUint32BE(buf, 10, titleBytes.length);
    buf.set(titleBytes, 14);
    writeUint32BE(buf, 14 + titleBytes.length, bodyBytes.length);
    buf.set(bodyBytes, 14 + titleBytes.length + 4);
    return buf;
  } else {
    const bodyBytes = enc.encode(payload.body);
    const parentBytes = hexToBytes(payload.parentMessageHash);
    // version(1) + kind(1) + ts(8) + parentHash(32) + bodyLen(4) + body
    const buf = new Uint8Array(1 + 1 + 8 + 32 + 4 + bodyBytes.length);
    buf[0] = 0x01;
    buf[1] = FORUM_KIND_REPLY;
    writeBigUint64BE(buf, 2, payload.timestamp);
    buf.set(parentBytes, 10);
    writeUint32BE(buf, 42, bodyBytes.length);
    buf.set(bodyBytes, 46);
    return buf;
  }
}

export function decodeForumPayload(bytes: Uint8Array): ForumPayload {
  const kind = bytes[1];
  const timestamp = readBigUint64BE(bytes, 2);

  if (kind === FORUM_KIND_POST) {
    const titleLen = readUint32BE(bytes, 10);
    const title = dec.decode(bytes.slice(14, 14 + titleLen));
    const bodyLen = readUint32BE(bytes, 14 + titleLen);
    const body = dec.decode(bytes.slice(14 + titleLen + 4, 14 + titleLen + 4 + bodyLen));
    return { kind: FORUM_KIND_POST, timestamp, title, body };
  } else {
    const parentHash = bytesToHex(bytes.slice(10, 42)) as Bytes32;
    const bodyLen = readUint32BE(bytes, 42);
    const body = dec.decode(bytes.slice(46, 46 + bodyLen));
    return { kind: FORUM_KIND_REPLY, timestamp, parentMessageHash: parentHash, body };
  }
}

export function forumMessageHash(sender: Address, nonce: bigint, payload: Uint8Array): Bytes32 {
  return computeMessageHash(sender, nonce, payload);
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return '0x' + Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}
