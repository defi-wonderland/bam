import { describe, expect, it } from 'vitest';
import type { Bytes32 } from 'bam-sdk';

import {
  decodeTwitterContents,
  encodeTwitterContents,
  type TwitterMessage,
} from '../../src/lib/contents-codec';

const TAG = ('0x' + 'aa'.repeat(32)) as Bytes32;
const PARENT = ('0x' + 'bb'.repeat(32)) as Bytes32;

describe('encodeTwitterContents / decodeTwitterContents — post', () => {
  it('round-trips a plain ASCII post', () => {
    const msg: TwitterMessage = {
      kind: 'post',
      timestamp: 1_700_000_000,
      content: 'hello world',
    };
    const encoded = encodeTwitterContents(TAG, msg);
    const decoded = decodeTwitterContents(encoded);
    expect(decoded.contentTag.toLowerCase()).toBe(TAG.toLowerCase());
    expect(decoded.app).toEqual(msg);
  });

  it('round-trips unicode (emoji + CJK)', () => {
    const msg: TwitterMessage = {
      kind: 'post',
      timestamp: 1_800_000_000,
      content: '🐳 こんにちは',
    };
    const encoded = encodeTwitterContents(TAG, msg);
    expect(decodeTwitterContents(encoded).app).toEqual(msg);
  });

  it('round-trips empty content', () => {
    const msg: TwitterMessage = { kind: 'post', timestamp: 0, content: '' };
    const encoded = encodeTwitterContents(TAG, msg);
    expect(decodeTwitterContents(encoded).app).toEqual(msg);
  });

  it('first 32 bytes of contents is the contentTag prefix', () => {
    const encoded = encodeTwitterContents(TAG, {
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
    const encoded = encodeTwitterContents(TAG, {
      kind: 'post',
      timestamp: 1,
      content: 'x',
    });
    expect(encoded[32]).toBe(0x01);
  });

  it('byte 33 is the kind byte (0x00 for post)', () => {
    const encoded = encodeTwitterContents(TAG, {
      kind: 'post',
      timestamp: 1,
      content: 'x',
    });
    expect(encoded[33]).toBe(0x00);
  });
});

describe('encodeTwitterContents / decodeTwitterContents — reply', () => {
  it('round-trips a reply with parentMessageHash', () => {
    const msg: TwitterMessage = {
      kind: 'reply',
      timestamp: 1_700_000_000,
      parentMessageHash: PARENT,
      content: 'thoughtful reply',
    };
    const encoded = encodeTwitterContents(TAG, msg);
    const decoded = decodeTwitterContents(encoded);
    expect(decoded.contentTag.toLowerCase()).toBe(TAG.toLowerCase());
    expect(decoded.app).toEqual(msg);
  });

  it('round-trips a reply with empty content (image-only style)', () => {
    const msg: TwitterMessage = {
      kind: 'reply',
      timestamp: 0,
      parentMessageHash: PARENT,
      content: '',
    };
    const encoded = encodeTwitterContents(TAG, msg);
    expect(decodeTwitterContents(encoded).app).toEqual(msg);
  });

  it('byte 33 is the kind byte (0x01 for reply)', () => {
    const encoded = encodeTwitterContents(TAG, {
      kind: 'reply',
      timestamp: 1,
      parentMessageHash: PARENT,
      content: 'x',
    });
    expect(encoded[33]).toBe(0x01);
  });

  it('parentMessageHash sits at appBytes[10..42]', () => {
    const encoded = encodeTwitterContents(TAG, {
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
      encodeTwitterContents(TAG, {
        kind: 'reply',
        timestamp: 1,
        parentMessageHash: '0xdeadbeef' as Bytes32,
        content: 'x',
      })
    ).toThrow();
  });
});

describe('encodeTwitterContents / decodeTwitterContents — negatives', () => {
  it('rejects a buffer shorter than the contentTag prefix', () => {
    expect(() => decodeTwitterContents(new Uint8Array(31))).toThrow();
  });

  it('rejects a buffer with no envelope header', () => {
    // 32-byte tag, no app bytes at all
    const full = new Uint8Array(32);
    expect(() => decodeTwitterContents(full)).toThrow();
  });

  it('rejects an unknown envelope version', () => {
    const encoded = encodeTwitterContents(TAG, {
      kind: 'post',
      timestamp: 1,
      content: 'x',
    });
    encoded[32] = 0x02;
    expect(() => decodeTwitterContents(encoded)).toThrow(/version/);
  });

  it('rejects an unknown kind byte', () => {
    const encoded = encodeTwitterContents(TAG, {
      kind: 'post',
      timestamp: 1,
      content: 'x',
    });
    encoded[33] = 0x7f;
    expect(() => decodeTwitterContents(encoded)).toThrow(/kind/);
  });

  it('rejects a post body declaring a content length past the buffer', () => {
    const encoded = encodeTwitterContents(TAG, {
      kind: 'post',
      timestamp: 1,
      content: 'abc',
    });
    // contentLen sits at appBytes offset 10 → absolute 42..46 (BE u32).
    encoded[42] = 0xff;
    encoded[43] = 0xff;
    encoded[44] = 0xff;
    encoded[45] = 0xff;
    expect(() => decodeTwitterContents(encoded)).toThrow();
  });

  it('rejects a reply body declaring a content length past the buffer', () => {
    const encoded = encodeTwitterContents(TAG, {
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
    expect(() => decodeTwitterContents(encoded)).toThrow();
  });

  it('rejects a buffer with truncated post body', () => {
    const encoded = encodeTwitterContents(TAG, {
      kind: 'post',
      timestamp: 1,
      content: 'abc',
    });
    expect(() => decodeTwitterContents(encoded.slice(0, encoded.length - 1))).toThrow();
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
    expect(() => decodeTwitterContents(full)).toThrow();
  });
});
