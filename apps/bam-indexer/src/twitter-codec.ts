/**
 * Decoder for bam-twitter's app-specific message contents.
 *
 * Layout inside contents[32:] (appBytes):
 *   byte  0       version (0x01)
 *   byte  1       kind    (0x00 = post, 0x01 = reply)
 *
 * Post payload (from byte 2):
 *   bytes  0..7   uint64 BE timestamp (Unix epoch seconds)
 *   bytes  8..11  uint32 BE UTF-8 content length
 *   bytes 12..    UTF-8 content
 *
 * Reply payload (from byte 2):
 *   bytes  0..7   uint64 BE timestamp
 *   bytes  8..39  bytes32 parentMessageHash
 *   bytes 40..43  uint32 BE UTF-8 content length
 *   bytes 44..    UTF-8 content
 */

import { TextDecoder } from 'node:util';
import { splitContents } from 'bam-sdk';
import type { Bytes32 } from 'bam-sdk';

const ENVELOPE_VERSION = 0x01;
const KIND_POST = 0x00;
const KIND_REPLY = 0x01;

export type TwitterMessage =
  | { kind: 'post'; timestamp: number; content: string }
  | { kind: 'reply'; timestamp: number; parentMessageHash: Bytes32; content: string };

const textDecoder = new TextDecoder('utf-8', { fatal: true });

export function decodeTwitterContents(contents: Uint8Array): {
  contentTag: Bytes32;
  app: TwitterMessage;
} {
  const { contentTag, appBytes } = splitContents(contents);

  if (appBytes.length < 2) throw new RangeError('twitter contents too short for envelope header');
  const version = appBytes[0];
  const kind = appBytes[1];
  if (version !== ENVELOPE_VERSION) throw new RangeError(`unsupported envelope version: ${version}`);

  if (kind === KIND_POST) {
    if (appBytes.length < 14) throw new RangeError('post payload too short');
    const timestamp = Number(readU64BE(appBytes, 2));
    const contentLen = readU32BE(appBytes, 10);
    if (14 + contentLen > appBytes.length) throw new RangeError('post: content overruns buffer');
    const content = textDecoder.decode(appBytes.slice(14, 14 + contentLen));
    return { contentTag, app: { kind: 'post', timestamp, content } };
  }

  if (kind === KIND_REPLY) {
    if (appBytes.length < 46) throw new RangeError('reply payload too short');
    const timestamp = Number(readU64BE(appBytes, 2));
    const parentMessageHash = bytesToHex(appBytes.slice(10, 42)) as Bytes32;
    const contentLen = readU32BE(appBytes, 42);
    if (46 + contentLen > appBytes.length) throw new RangeError('reply: content overruns buffer');
    const content = textDecoder.decode(appBytes.slice(46, 46 + contentLen));
    return { contentTag, app: { kind: 'reply', timestamp, parentMessageHash, content } };
  }

  throw new RangeError(`unknown twitter kind: ${kind}`);
}

function readU32BE(buf: Uint8Array, offset: number): number {
  return (buf[offset] * 0x1000000) + (buf[offset + 1] << 16) + (buf[offset + 2] << 8) + buf[offset + 3];
}

function readU64BE(buf: Uint8Array, offset: number): bigint {
  let v = 0n;
  for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(buf[offset + i]);
  return v;
}

function bytesToHex(b: Uint8Array): string {
  return '0x' + Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
}
