import { describe, expect, it } from 'vitest';
import type { Bytes32 } from '../browser.js';

import {
  decodePostReplyContents,
  encodePostReplyContents,
  type PostReplyMessage,
} from './index.js';

const PARENT = ('0x' + 'bb'.repeat(32)) as Bytes32;

describe('encodePostReplyContents / decodePostReplyContents — post', () => {
  it('round-trips a plain ASCII post', () => {
    const msg: PostReplyMessage = {
      kind: 'post',
      timestamp: 1_700_000_000,
      content: 'hello world',
    };
    const encoded = encodePostReplyContents(msg);
    const decoded = decodePostReplyContents(encoded);
    expect(decoded).toEqual(msg);
  });

  it('round-trips unicode (emoji + CJK)', () => {
    const msg: PostReplyMessage = {
      kind: 'post',
      timestamp: 1_800_000_000,
      content: '🐳 こんにちは',
    };
    const encoded = encodePostReplyContents(msg);
    expect(decodePostReplyContents(encoded)).toEqual(msg);
  });

  it('round-trips empty content', () => {
    const msg: PostReplyMessage = { kind: 'post', timestamp: 0, content: '' };
    const encoded = encodePostReplyContents(msg);
    expect(decodePostReplyContents(encoded)).toEqual(msg);
  });

  it('byte 0 is the envelope version (0x01)', () => {
    const encoded = encodePostReplyContents({
      kind: 'post',
      timestamp: 1,
      content: 'x',
    });
    expect(encoded[0]).toBe(0x01);
  });

  it('byte 1 is the kind byte (0x00 for post)', () => {
    const encoded = encodePostReplyContents({
      kind: 'post',
      timestamp: 1,
      content: 'x',
    });
    expect(encoded[1]).toBe(0x00);
  });
});

describe('encodePostReplyContents / decodePostReplyContents — reply', () => {
  it('round-trips a reply with parentMessageHash', () => {
    const msg: PostReplyMessage = {
      kind: 'reply',
      timestamp: 1_700_000_000,
      parentMessageHash: PARENT,
      content: 'thoughtful reply',
    };
    const encoded = encodePostReplyContents(msg);
    const decoded = decodePostReplyContents(encoded);
    expect(decoded).toEqual(msg);
  });

  it('round-trips a reply with empty content (image-only style)', () => {
    const msg: PostReplyMessage = {
      kind: 'reply',
      timestamp: 0,
      parentMessageHash: PARENT,
      content: '',
    };
    const encoded = encodePostReplyContents(msg);
    expect(decodePostReplyContents(encoded)).toEqual(msg);
  });

  it('byte 1 is the kind byte (0x01 for reply)', () => {
    const encoded = encodePostReplyContents({
      kind: 'reply',
      timestamp: 1,
      parentMessageHash: PARENT,
      content: 'x',
    });
    expect(encoded[1]).toBe(0x01);
  });

  it('parentMessageHash sits at bytes [10..42]', () => {
    const encoded = encodePostReplyContents({
      kind: 'reply',
      timestamp: 1,
      parentMessageHash: PARENT,
      content: 'x',
    });
    // 2-byte envelope header + 8-byte ts = 10; parent occupies 10..42.
    const slice =
      '0x' +
      Array.from(encoded.slice(10, 42))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    expect(slice).toBe(PARENT);
  });

  it('rejects a non-32-byte parentMessageHash', () => {
    expect(() =>
      encodePostReplyContents({
        kind: 'reply',
        timestamp: 1,
        parentMessageHash: '0xdeadbeef' as Bytes32,
        content: 'x',
      })
    ).toThrow();
  });
});

describe('encodePostReplyContents / decodePostReplyContents — negatives', () => {
  it('rejects a buffer with no envelope header', () => {
    expect(() => decodePostReplyContents(new Uint8Array(0))).toThrow();
    expect(() => decodePostReplyContents(new Uint8Array(1))).toThrow();
  });

  it('rejects an unknown envelope version', () => {
    const encoded = encodePostReplyContents({
      kind: 'post',
      timestamp: 1,
      content: 'x',
    });
    encoded[0] = 0x02;
    expect(() => decodePostReplyContents(encoded)).toThrow(/version/);
  });

  it('rejects an unknown kind byte', () => {
    const encoded = encodePostReplyContents({
      kind: 'post',
      timestamp: 1,
      content: 'x',
    });
    encoded[1] = 0x7f;
    expect(() => decodePostReplyContents(encoded)).toThrow(/kind/);
  });

  it('rejects a post body declaring a content length past the buffer', () => {
    const encoded = encodePostReplyContents({
      kind: 'post',
      timestamp: 1,
      content: 'abc',
    });
    // contentLen sits at offset 10 (BE u32).
    encoded[10] = 0xff;
    encoded[11] = 0xff;
    encoded[12] = 0xff;
    encoded[13] = 0xff;
    expect(() => decodePostReplyContents(encoded)).toThrow();
  });

  it('rejects a reply body declaring a content length past the buffer', () => {
    const encoded = encodePostReplyContents({
      kind: 'reply',
      timestamp: 1,
      parentMessageHash: PARENT,
      content: 'abc',
    });
    // contentLen sits at offset 42 (BE u32).
    encoded[42] = 0xff;
    encoded[43] = 0xff;
    encoded[44] = 0xff;
    encoded[45] = 0xff;
    expect(() => decodePostReplyContents(encoded)).toThrow();
  });

  it('rejects a buffer with truncated post body', () => {
    const encoded = encodePostReplyContents({
      kind: 'post',
      timestamp: 1,
      content: 'abc',
    });
    expect(() => decodePostReplyContents(encoded.slice(0, encoded.length - 1))).toThrow();
  });

  it('rejects a reply body with invalid UTF-8 content', () => {
    // Manually frame a reply with two malformed UTF-8 bytes.
    const body = new Uint8Array(2 + 8 + 32 + 4 + 2);
    body[0] = 0x01; // version
    body[1] = 0x01; // reply kind
    // ts = 1 → last byte 1
    body[9] = 1;
    // parent
    for (let i = 10; i < 42; i++) body[i] = 0xbb;
    // contentLen = 2
    body[42] = 0;
    body[43] = 0;
    body[44] = 0;
    body[45] = 2;
    // content: invalid UTF-8 (lone continuation bytes)
    body[46] = 0x80;
    body[47] = 0x80;
    expect(() => decodePostReplyContents(body)).toThrow();
  });
});
