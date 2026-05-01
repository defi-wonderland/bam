/**
 * Round-trip and negative cases for the blog demo's app-opaque
 * contents codec. Mirrors the bam-twitter codec test, with offsets
 * shifted to account for the 32-byte `postIdHash` slot inserted
 * between the kind byte and the timestamp.
 */

import { describe, expect, it } from 'vitest';
import type { Bytes32 } from 'bam-sdk';

import {
  decodeBlogContents,
  encodeBlogContents,
  type BlogMessage,
} from '../src/widget/codec.js';

const TAG = ('0x' + 'aa'.repeat(32)) as Bytes32;
const POST = ('0x' + 'cc'.repeat(32)) as Bytes32;
const PARENT = ('0x' + 'bb'.repeat(32)) as Bytes32;

describe('encodeBlogContents / decodeBlogContents — comment', () => {
  it('round-trips a plain ASCII comment', () => {
    const msg: BlogMessage = {
      kind: 'comment',
      postIdHash: POST,
      timestamp: 1_700_000_000,
      content: 'first',
    };
    const encoded = encodeBlogContents(TAG, msg);
    const decoded = decodeBlogContents(encoded);
    expect(decoded.contentTag.toLowerCase()).toBe(TAG.toLowerCase());
    expect(decoded.app).toEqual(msg);
  });

  it('round-trips unicode (emoji + CJK)', () => {
    const msg: BlogMessage = {
      kind: 'comment',
      postIdHash: POST,
      timestamp: 1_800_000_000,
      content: '🐳 こんにちは',
    };
    expect(decodeBlogContents(encodeBlogContents(TAG, msg)).app).toEqual(msg);
  });

  it('round-trips empty content', () => {
    const msg: BlogMessage = {
      kind: 'comment',
      postIdHash: POST,
      timestamp: 0,
      content: '',
    };
    expect(decodeBlogContents(encodeBlogContents(TAG, msg)).app).toEqual(msg);
  });

  it('first 32 bytes is the contentTag prefix', () => {
    const encoded = encodeBlogContents(TAG, {
      kind: 'comment',
      postIdHash: POST,
      timestamp: 1,
      content: 'x',
    });
    const prefix =
      '0x' +
      Array.from(encoded.slice(0, 32))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    expect(prefix).toBe(TAG);
  });

  it('byte 32 is the envelope version (0x01)', () => {
    const encoded = encodeBlogContents(TAG, {
      kind: 'comment',
      postIdHash: POST,
      timestamp: 1,
      content: 'x',
    });
    expect(encoded[32]).toBe(0x01);
  });

  it('byte 33 is the kind byte (0x00 for comment)', () => {
    const encoded = encodeBlogContents(TAG, {
      kind: 'comment',
      postIdHash: POST,
      timestamp: 1,
      content: 'x',
    });
    expect(encoded[33]).toBe(0x00);
  });

  it('postIdHash sits at appBytes[2..34] / absolute [34..66]', () => {
    const encoded = encodeBlogContents(TAG, {
      kind: 'comment',
      postIdHash: POST,
      timestamp: 1,
      content: 'x',
    });
    const slice =
      '0x' +
      Array.from(encoded.slice(34, 66))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    expect(slice).toBe(POST);
  });
});

describe('encodeBlogContents / decodeBlogContents — reply', () => {
  it('round-trips a reply with parentMessageHash', () => {
    const msg: BlogMessage = {
      kind: 'reply',
      postIdHash: POST,
      timestamp: 1_700_000_000,
      parentMessageHash: PARENT,
      content: 'thoughtful reply',
    };
    const encoded = encodeBlogContents(TAG, msg);
    const decoded = decodeBlogContents(encoded);
    expect(decoded.contentTag.toLowerCase()).toBe(TAG.toLowerCase());
    expect(decoded.app).toEqual(msg);
  });

  it('byte 33 is the kind byte (0x01 for reply)', () => {
    const encoded = encodeBlogContents(TAG, {
      kind: 'reply',
      postIdHash: POST,
      timestamp: 1,
      parentMessageHash: PARENT,
      content: 'x',
    });
    expect(encoded[33]).toBe(0x01);
  });

  it('parentMessageHash sits at absolute [74..106]', () => {
    const encoded = encodeBlogContents(TAG, {
      kind: 'reply',
      postIdHash: POST,
      timestamp: 1,
      parentMessageHash: PARENT,
      content: 'x',
    });
    // 32-byte tag + 2-byte envelope header + 32-byte postIdHash + 8-byte ts = 74.
    const slice =
      '0x' +
      Array.from(encoded.slice(74, 106))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    expect(slice).toBe(PARENT);
  });

  it('rejects a non-32-byte parentMessageHash', () => {
    expect(() =>
      encodeBlogContents(TAG, {
        kind: 'reply',
        postIdHash: POST,
        timestamp: 1,
        parentMessageHash: '0xdeadbeef' as Bytes32,
        content: 'x',
      })
    ).toThrow();
  });

  it('rejects a non-32-byte postIdHash', () => {
    expect(() =>
      encodeBlogContents(TAG, {
        kind: 'comment',
        postIdHash: '0xdeadbeef' as Bytes32,
        timestamp: 1,
        content: 'x',
      })
    ).toThrow();
  });
});

describe('encodeBlogContents / decodeBlogContents — negatives', () => {
  it('rejects a buffer shorter than the contentTag prefix', () => {
    expect(() => decodeBlogContents(new Uint8Array(31))).toThrow();
  });

  it('rejects a buffer with no envelope header', () => {
    expect(() => decodeBlogContents(new Uint8Array(32))).toThrow();
  });

  it('rejects an unknown envelope version', () => {
    const encoded = encodeBlogContents(TAG, {
      kind: 'comment',
      postIdHash: POST,
      timestamp: 1,
      content: 'x',
    });
    encoded[32] = 0x02;
    expect(() => decodeBlogContents(encoded)).toThrow(/version/);
  });

  it('rejects an unknown kind byte', () => {
    const encoded = encodeBlogContents(TAG, {
      kind: 'comment',
      postIdHash: POST,
      timestamp: 1,
      content: 'x',
    });
    encoded[33] = 0x7f;
    expect(() => decodeBlogContents(encoded)).toThrow(/kind/);
  });

  it('rejects a comment whose contentLen runs past the buffer', () => {
    const encoded = encodeBlogContents(TAG, {
      kind: 'comment',
      postIdHash: POST,
      timestamp: 1,
      content: 'abc',
    });
    // contentLen at appBytes offset 42 → absolute 74..78.
    encoded[74] = 0xff;
    encoded[75] = 0xff;
    encoded[76] = 0xff;
    encoded[77] = 0xff;
    expect(() => decodeBlogContents(encoded)).toThrow();
  });

  it('rejects a reply whose contentLen runs past the buffer', () => {
    const encoded = encodeBlogContents(TAG, {
      kind: 'reply',
      postIdHash: POST,
      timestamp: 1,
      parentMessageHash: PARENT,
      content: 'abc',
    });
    // contentLen at appBytes offset 74 → absolute 106..110.
    encoded[106] = 0xff;
    encoded[107] = 0xff;
    encoded[108] = 0xff;
    encoded[109] = 0xff;
    expect(() => decodeBlogContents(encoded)).toThrow();
  });

  it('rejects a truncated comment body', () => {
    const encoded = encodeBlogContents(TAG, {
      kind: 'comment',
      postIdHash: POST,
      timestamp: 1,
      content: 'abc',
    });
    expect(() =>
      decodeBlogContents(encoded.slice(0, encoded.length - 1))
    ).toThrow();
  });

  it('rejects invalid UTF-8 content', () => {
    // Frame a comment with two malformed UTF-8 bytes.
    const tagBytes = new Uint8Array(32).fill(0xaa);
    const body = new Uint8Array(2 + 32 + 8 + 4 + 2);
    body[0] = 0x01;
    body[1] = 0x00; // comment
    for (let i = 2; i < 34; i++) body[i] = 0xcc;
    body[41] = 1; // ts = 1
    body[45] = 2; // contentLen = 2
    body[46] = 0xff;
    body[47] = 0xfe;
    const full = new Uint8Array(tagBytes.length + body.length);
    full.set(tagBytes, 0);
    full.set(body, tagBytes.length);
    expect(() => decodeBlogContents(full)).toThrow();
  });
});
