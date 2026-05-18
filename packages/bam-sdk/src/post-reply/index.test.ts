import { describe, expect, it } from 'vitest';
import type { Bytes32 } from '../browser.js';

import {
  decodePostReplyContents,
  encodePostReplyContents,
  type PostReplyMessage,
} from './index.js';

const TAG = ('0x' + 'aa'.repeat(32)) as Bytes32;
const PARENT = ('0x' + 'bb'.repeat(32)) as Bytes32;

describe('encodePostReplyContents / decodePostReplyContents — post', () => {
  it('round-trips a plain ASCII post', () => {
    const msg: PostReplyMessage = {
      kind: 'post',
      timestamp: 1_700_000_000,
      content: 'hello world',
    };
    const encoded = encodePostReplyContents(TAG, msg);
    const decoded = decodePostReplyContents(encoded);
    expect(decoded.contentTag.toLowerCase()).toBe(TAG.toLowerCase());
    expect(decoded.app).toEqual(msg);
  });

  it('round-trips unicode (emoji + CJK)', () => {
    const msg: PostReplyMessage = {
      kind: 'post',
      timestamp: 1_800_000_000,
      content: '🐳 こんにちは',
    };
    const encoded = encodePostReplyContents(TAG, msg);
    expect(decodePostReplyContents(encoded).app).toEqual(msg);
  });

  it('round-trips empty content', () => {
    const msg: PostReplyMessage = { kind: 'post', timestamp: 0, content: '' };
    const encoded = encodePostReplyContents(TAG, msg);
    expect(decodePostReplyContents(encoded).app).toEqual(msg);
  });

  it('first 32 bytes of contents is the contentTag prefix', () => {
    const encoded = encodePostReplyContents(TAG, {
      kind: 'post',
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
    const encoded = encodePostReplyContents(TAG, {
      kind: 'post',
      timestamp: 1,
      content: 'x',
    });
    expect(encoded[32]).toBe(0x01);
  });

  it('byte 33 is the kind byte (0x00 for post)', () => {
    const encoded = encodePostReplyContents(TAG, {
      kind: 'post',
      timestamp: 1,
      content: 'x',
    });
    expect(encoded[33]).toBe(0x00);
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
    const encoded = encodePostReplyContents(TAG, msg);
    const decoded = decodePostReplyContents(encoded);
    expect(decoded.contentTag.toLowerCase()).toBe(TAG.toLowerCase());
    expect(decoded.app).toEqual(msg);
  });

  it('round-trips a reply with empty content (image-only style)', () => {
    const msg: PostReplyMessage = {
      kind: 'reply',
      timestamp: 0,
      parentMessageHash: PARENT,
      content: '',
    };
    const encoded = encodePostReplyContents(TAG, msg);
    expect(decodePostReplyContents(encoded).app).toEqual(msg);
  });

  it('byte 33 is the kind byte (0x01 for reply)', () => {
    const encoded = encodePostReplyContents(TAG, {
      kind: 'reply',
      timestamp: 1,
      parentMessageHash: PARENT,
      content: 'x',
    });
    expect(encoded[33]).toBe(0x01);
  });

  it('parentMessageHash sits at appBytes[10..42]', () => {
    const encoded = encodePostReplyContents(TAG, {
      kind: 'reply',
      timestamp: 1,
      parentMessageHash: PARENT,
      content: 'x',
    });
    // 32-byte tag + 2-byte envelope header + 8-byte ts = 42; parent occupies 42..74.
    const slice =
      '0x' +
      Array.from(encoded.slice(42, 74))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    expect(slice).toBe(PARENT);
  });

  it('rejects a non-32-byte parentMessageHash', () => {
    expect(() =>
      encodePostReplyContents(TAG, {
        kind: 'reply',
        timestamp: 1,
        parentMessageHash: '0xdeadbeef' as Bytes32,
        content: 'x',
      })
    ).toThrow();
  });
});

describe('encodePostReplyContents / decodePostReplyContents — negatives', () => {
  it('rejects a buffer shorter than the contentTag prefix', () => {
    expect(() => decodePostReplyContents(new Uint8Array(31))).toThrow();
  });

  it('rejects a buffer with no envelope header', () => {
    // 32-byte tag, no app bytes at all
    const full = new Uint8Array(32);
    expect(() => decodePostReplyContents(full)).toThrow();
  });

  it('rejects an unknown envelope version', () => {
    const encoded = encodePostReplyContents(TAG, {
      kind: 'post',
      timestamp: 1,
      content: 'x',
    });
    encoded[32] = 0x02;
    expect(() => decodePostReplyContents(encoded)).toThrow(/version/);
  });

  it('rejects an unknown kind byte', () => {
    const encoded = encodePostReplyContents(TAG, {
      kind: 'post',
      timestamp: 1,
      content: 'x',
    });
    encoded[33] = 0x7f;
    expect(() => decodePostReplyContents(encoded)).toThrow(/kind/);
  });

  it('rejects a post body declaring a content length past the buffer', () => {
    const encoded = encodePostReplyContents(TAG, {
      kind: 'post',
      timestamp: 1,
      content: 'abc',
    });
    // contentLen sits at appBytes offset 10 → absolute 42..46 (BE u32).
    encoded[42] = 0xff;
    encoded[43] = 0xff;
    encoded[44] = 0xff;
    encoded[45] = 0xff;
    expect(() => decodePostReplyContents(encoded)).toThrow();
  });

  it('rejects a reply body declaring a content length past the buffer', () => {
    const encoded = encodePostReplyContents(TAG, {
      kind: 'reply',
      timestamp: 1,
      parentMessageHash: PARENT,
      content: 'abc',
    });
    // contentLen sits at appBytes offset 42 → absolute 74..78 (BE u32).
    encoded[74] = 0xff;
    encoded[75] = 0xff;
    encoded[76] = 0xff;
    encoded[77] = 0xff;
    expect(() => decodePostReplyContents(encoded)).toThrow();
  });

  it('rejects a buffer with truncated post body', () => {
    const encoded = encodePostReplyContents(TAG, {
      kind: 'post',
      timestamp: 1,
      content: 'abc',
    });
    expect(() => decodePostReplyContents(encoded.slice(0, encoded.length - 1))).toThrow();
  });

  it('rejects a reply body with invalid UTF-8 content', () => {
    // Manually frame a reply with two malformed UTF-8 bytes.
    const tagBytes = new Uint8Array(32).fill(0xaa);
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
    body[46] = 0xff;
    body[47] = 0xfe;
    const full = new Uint8Array(tagBytes.length + body.length);
    full.set(tagBytes, 0);
    full.set(body, tagBytes.length);
    expect(() => decodePostReplyContents(full)).toThrow();
  });
});
