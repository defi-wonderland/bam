import { describe, it, expect } from 'vitest';

import {
  encodeCommentContents,
  decodeCommentContents,
  type CommentEnvelope,
} from '../src/codec.js';
import { BAM_COMMENTS_TAG } from '../src/content-tag.js';

const POST_ID_HASH = ('0x' + 'ab'.repeat(32)) as `0x${string}`;
const PARENT_HASH = ('0x' + 'cd'.repeat(32)) as `0x${string}`;

describe('codec round-trip', () => {
  it('comment encode → decode preserves every field', () => {
    const msg: CommentEnvelope = {
      kind: 'comment',
      postIdHash: POST_ID_HASH,
      timestamp: 1_730_000_000,
      content: 'hello — world 🌎',
    };
    const bytes = encodeCommentContents(BAM_COMMENTS_TAG, msg);
    const { contentTag, envelope } = decodeCommentContents(bytes);
    expect(contentTag).toBe(BAM_COMMENTS_TAG);
    expect(envelope).toEqual(msg);
  });

  it('reply encode → decode preserves parentMessageHash', () => {
    const msg: CommentEnvelope = {
      kind: 'reply',
      postIdHash: POST_ID_HASH,
      timestamp: 1_730_000_001,
      parentMessageHash: PARENT_HASH,
      content: 're: hello',
    };
    const bytes = encodeCommentContents(BAM_COMMENTS_TAG, msg);
    const { envelope } = decodeCommentContents(bytes);
    expect(envelope).toEqual(msg);
  });
});

describe('codec rejects malformed input', () => {
  function tag(): Uint8Array {
    const out = new Uint8Array(32);
    const hex = BAM_COMMENTS_TAG.slice(2);
    for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
  }

  it('throws on short buffer (no envelope header)', () => {
    const buf = new Uint8Array(33);
    buf.set(tag(), 0);
    expect(() => decodeCommentContents(buf)).toThrow();
  });

  it('throws on unknown version byte', () => {
    const buf = new Uint8Array(46);
    buf.set(tag(), 0);
    buf[32] = 0xff; // unknown version
    expect(() => decodeCommentContents(buf)).toThrow(/version/);
  });

  it('throws on unknown kind', () => {
    const buf = new Uint8Array(46);
    buf.set(tag(), 0);
    buf[32] = 0x01;
    buf[33] = 0x42; // unknown kind
    expect(() => decodeCommentContents(buf)).toThrow(/kind/);
  });

  it('throws when declared content length runs past buffer', () => {
    const msg: CommentEnvelope = {
      kind: 'comment',
      postIdHash: POST_ID_HASH,
      timestamp: 1_730_000_000,
      content: 'hi',
    };
    const bytes = encodeCommentContents(BAM_COMMENTS_TAG, msg);
    // Find contentLen field (last 4 bytes before 'hi') and inflate.
    const lenOff = 32 + 42; // tag + comment K=42
    bytes[lenOff] = 0x00;
    bytes[lenOff + 1] = 0x00;
    bytes[lenOff + 2] = 0x10;
    bytes[lenOff + 3] = 0x00;
    expect(() => decodeCommentContents(bytes)).toThrow(/length runs past buffer/);
  });

  it('throws on invalid UTF-8 inside the content slice', () => {
    const msg: CommentEnvelope = {
      kind: 'comment',
      postIdHash: POST_ID_HASH,
      timestamp: 1_730_000_000,
      content: 'x',
    };
    const bytes = encodeCommentContents(BAM_COMMENTS_TAG, msg);
    // Overwrite the single content byte with a lone continuation
    // byte (0x80) that's invalid as the start of a code point.
    bytes[bytes.length - 1] = 0x80;
    expect(() => decodeCommentContents(bytes)).toThrow();
  });

  it('rejects non-32-byte postIdHash on encode', () => {
    expect(() =>
      encodeCommentContents(BAM_COMMENTS_TAG, {
        kind: 'comment',
        postIdHash: '0xdead' as `0x${string}`,
        timestamp: 0,
        content: 'x',
      })
    ).toThrow();
  });

  it('rejects non-32-byte parentMessageHash on encode', () => {
    expect(() =>
      encodeCommentContents(BAM_COMMENTS_TAG, {
        kind: 'reply',
        postIdHash: POST_ID_HASH,
        parentMessageHash: '0xbeef' as `0x${string}`,
        timestamp: 0,
        content: 'x',
      })
    ).toThrow();
  });

  it('throws when reply payload is too short to read parent hash', () => {
    // Build a reply prefix without enough room for parent hash.
    const buf = new Uint8Array(32 + 42 + 5); // tag + (version,kind,postIdHash,ts) + 5 bytes
    buf.set(tag(), 0);
    buf[32] = 0x01; // version
    buf[33] = 0x01; // reply
    expect(() => decodeCommentContents(buf)).toThrow(/reply payload too short/);
  });
});
