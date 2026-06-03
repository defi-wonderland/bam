import { keccak_256 } from '@noble/hashes/sha3';
import { describe, expect, it } from 'vitest';

import type { Bytes32 } from '../types.js';

import {
  FORUM_TAG,
  decodeForumContents,
  encodeForumContents,
  type ForumLike,
  type ForumPost,
  type ForumReply,
} from './index.js';

const PARENT = ('0x' + 'bb'.repeat(32)) as Bytes32;
const TARGET = ('0x' + 'cc'.repeat(32)) as Bytes32;

describe('FORUM_TAG', () => {
  it('equals keccak256("bam-forum-demo.v1")', () => {
    const expected =
      '0x' +
      Array.from(keccak_256(new TextEncoder().encode('bam-forum-demo.v1')))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    expect(FORUM_TAG).toBe(expected);
    expect(FORUM_TAG).toBe(
      '0x01bc15204a4c7779a37fd0d7988fe89a9cc4a148e7db926f4815f4c93ea879d1'
    );
  });
});

describe('encodeForumContents / decodeForumContents — post', () => {
  it('round-trips a plain ASCII post', () => {
    const msg: ForumPost = {
      kind: 0x00,
      version: 0x02,
      timestamp: 1_700_000_000n,
      tag: new TextEncoder().encode('general'),
      title: 'hello',
      body: 'world',
    };
    const encoded = encodeForumContents(msg);
    expect(decodeForumContents(encoded)).toEqual(msg);
  });

  it('round-trips unicode title and body', () => {
    const msg: ForumPost = {
      kind: 0x00,
      version: 0x02,
      timestamp: 1_800_000_000n,
      tag: new TextEncoder().encode('🐳'),
      title: '🐳 こんにちは',
      body: 'multiline\nbody with emoji 🎉',
    };
    const encoded = encodeForumContents(msg);
    expect(decodeForumContents(encoded)).toEqual(msg);
  });

  it('round-trips empty tag/title/body', () => {
    const msg: ForumPost = {
      kind: 0x00,
      version: 0x02,
      timestamp: 0n,
      tag: new Uint8Array(0),
      title: '',
      body: '',
    };
    const encoded = encodeForumContents(msg);
    expect(decodeForumContents(encoded)).toEqual(msg);
  });

  it('round-trips a 32-byte tag (max length)', () => {
    const msg: ForumPost = {
      kind: 0x00,
      version: 0x02,
      timestamp: 1n,
      tag: new Uint8Array(32).fill(0xab),
      title: 't',
      body: 'b',
    };
    const encoded = encodeForumContents(msg);
    expect(decodeForumContents(encoded)).toEqual(msg);
  });

  it('byte 0 is the post version (0x02), byte 1 the kind (0x00)', () => {
    const encoded = encodeForumContents({
      kind: 0x00,
      version: 0x02,
      timestamp: 1n,
      tag: new Uint8Array(0),
      title: '',
      body: '',
    });
    expect(encoded[0]).toBe(0x02);
    expect(encoded[1]).toBe(0x00);
  });

  it('rejects a tag larger than 32 bytes on encode', () => {
    expect(() =>
      encodeForumContents({
        kind: 0x00,
        version: 0x02,
        timestamp: 1n,
        tag: new Uint8Array(33),
        title: '',
        body: '',
      })
    ).toThrow(/tag exceeds 32 bytes/);
  });
});

describe('encodeForumContents / decodeForumContents — reply', () => {
  it('round-trips a reply with parentMessageHash', () => {
    const msg: ForumReply = {
      kind: 0x01,
      version: 0x01,
      timestamp: 1_700_000_000n,
      parentMessageHash: PARENT,
      body: 'thoughtful reply',
    };
    const encoded = encodeForumContents(msg);
    expect(decodeForumContents(encoded)).toEqual(msg);
  });

  it('round-trips a reply with empty body', () => {
    const msg: ForumReply = {
      kind: 0x01,
      version: 0x01,
      timestamp: 0n,
      parentMessageHash: PARENT,
      body: '',
    };
    expect(decodeForumContents(encodeForumContents(msg))).toEqual(msg);
  });

  it('byte 0 is the reply version (0x01), byte 1 the kind (0x01)', () => {
    const encoded = encodeForumContents({
      kind: 0x01,
      version: 0x01,
      timestamp: 1n,
      parentMessageHash: PARENT,
      body: 'x',
    });
    expect(encoded[0]).toBe(0x01);
    expect(encoded[1]).toBe(0x01);
  });

  it('parentMessageHash sits at bytes [10..42]', () => {
    const encoded = encodeForumContents({
      kind: 0x01,
      version: 0x01,
      timestamp: 1n,
      parentMessageHash: PARENT,
      body: '',
    });
    const slice =
      '0x' +
      Array.from(encoded.slice(10, 42))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    expect(slice).toBe(PARENT);
  });

  it('rejects a non-32-byte parentMessageHash on encode', () => {
    expect(() =>
      encodeForumContents({
        kind: 0x01,
        version: 0x01,
        timestamp: 1n,
        parentMessageHash: '0xdeadbeef' as Bytes32,
        body: 'x',
      })
    ).toThrow();
  });
});

describe('encodeForumContents / decodeForumContents — like', () => {
  it('round-trips a like', () => {
    const msg: ForumLike = {
      kind: 0x02,
      version: 0x01,
      timestamp: 1_700_000_000n,
      targetMessageHash: TARGET,
    };
    const encoded = encodeForumContents(msg);
    expect(encoded.length).toBe(42);
    expect(decodeForumContents(encoded)).toEqual(msg);
  });

  it('byte 0 is the like version (0x01), byte 1 the kind (0x02)', () => {
    const encoded = encodeForumContents({
      kind: 0x02,
      version: 0x01,
      timestamp: 1n,
      targetMessageHash: TARGET,
    });
    expect(encoded[0]).toBe(0x01);
    expect(encoded[1]).toBe(0x02);
  });

  it('rejects a truncated like buffer (missing target bytes)', () => {
    const encoded = encodeForumContents({
      kind: 0x02,
      version: 0x01,
      timestamp: 1n,
      targetMessageHash: TARGET,
    });
    expect(() => decodeForumContents(encoded.slice(0, 41))).toThrow();
  });

  it('rejects a non-32-byte targetMessageHash on encode', () => {
    expect(() =>
      encodeForumContents({
        kind: 0x02,
        version: 0x01,
        timestamp: 1n,
        targetMessageHash: '0xdeadbeef' as Bytes32,
      })
    ).toThrow();
  });
});

describe('encodeForumContents / decodeForumContents — negatives', () => {
  it('rejects a buffer with no envelope header', () => {
    expect(() => decodeForumContents(new Uint8Array(0))).toThrow();
    expect(() => decodeForumContents(new Uint8Array(1))).toThrow();
  });

  it('rejects a wrong version byte for an otherwise-valid post', () => {
    const encoded = encodeForumContents({
      kind: 0x00,
      version: 0x02,
      timestamp: 1n,
      tag: new Uint8Array(0),
      title: 'x',
      body: 'y',
    });
    encoded[0] = 0x01; // post must be version 0x02
    expect(() => decodeForumContents(encoded)).toThrow(/version, kind/);
  });

  it('rejects an unknown kind byte', () => {
    const encoded = encodeForumContents({
      kind: 0x00,
      version: 0x02,
      timestamp: 1n,
      tag: new Uint8Array(0),
      title: 'x',
      body: 'y',
    });
    encoded[1] = 0x7f;
    expect(() => decodeForumContents(encoded)).toThrow(/version, kind/);
  });

  it('rejects a post declaring a titleLen larger than the buffer', () => {
    const encoded = encodeForumContents({
      kind: 0x00,
      version: 0x02,
      timestamp: 1n,
      tag: new Uint8Array(0),
      title: 'abc',
      body: 'd',
    });
    // After version(1) kind(1) ts(8) tagLen(1) tag(0) the titleLen u32 sits at offset 11.
    encoded[11] = 0xff;
    encoded[12] = 0xff;
    encoded[13] = 0xff;
    encoded[14] = 0xff;
    expect(() => decodeForumContents(encoded)).toThrow(/title/);
  });

  it('rejects a post declaring a bodyLen larger than the buffer', () => {
    const encoded = encodeForumContents({
      kind: 0x00,
      version: 0x02,
      timestamp: 1n,
      tag: new Uint8Array(0),
      title: 'abc',
      body: 'd',
    });
    // titleLen at offset 11 = 3 → title at 15..18 → bodyLen u32 at 18.
    encoded[18] = 0xff;
    encoded[19] = 0xff;
    encoded[20] = 0xff;
    encoded[21] = 0xff;
    expect(() => decodeForumContents(encoded)).toThrow(/body/);
  });

  it('rejects a reply declaring a bodyLen larger than the buffer', () => {
    const encoded = encodeForumContents({
      kind: 0x01,
      version: 0x01,
      timestamp: 1n,
      parentMessageHash: PARENT,
      body: 'abc',
    });
    // bodyLen sits at offset 42.
    encoded[42] = 0xff;
    encoded[43] = 0xff;
    encoded[44] = 0xff;
    encoded[45] = 0xff;
    expect(() => decodeForumContents(encoded)).toThrow();
  });

  it('rejects a like with a truncated targetMessageHash', () => {
    const body = new Uint8Array(2 + 8 + 16);
    body[0] = 0x01;
    body[1] = 0x02;
    body[9] = 1;
    expect(() => decodeForumContents(body)).toThrow();
  });

  it('rejects a post with invalid UTF-8 in the title', () => {
    // Hand-frame: version=0x02, kind=0x00, ts=1, tagLen=0, titleLen=2, title=[0x80,0x80], bodyLen=0
    const body = new Uint8Array(2 + 8 + 1 + 0 + 4 + 2 + 4);
    body[0] = 0x02;
    body[1] = 0x00;
    body[9] = 1; // ts low byte
    body[10] = 0; // tagLen
    // titleLen = 2 at offset 11
    body[14] = 2;
    body[15] = 0x80;
    body[16] = 0x80;
    // bodyLen = 0 at offset 17
    expect(() => decodeForumContents(body)).toThrow();
  });

  it('rejects a post with invalid UTF-8 in the body', () => {
    const body = new Uint8Array(2 + 8 + 1 + 0 + 4 + 0 + 4 + 2);
    body[0] = 0x02;
    body[1] = 0x00;
    body[9] = 1; // ts low byte
    body[10] = 0; // tagLen
    // titleLen = 0 at offset 11..14
    // bodyLen = 2 at offset 15..18
    body[18] = 2;
    body[19] = 0x80;
    body[20] = 0x80;
    expect(() => decodeForumContents(body)).toThrow();
  });

  it('rejects a reply with invalid UTF-8 in the body', () => {
    const body = new Uint8Array(2 + 8 + 32 + 4 + 2);
    body[0] = 0x01;
    body[1] = 0x01;
    body[9] = 1;
    for (let i = 10; i < 42; i++) body[i] = 0xbb;
    body[45] = 2; // bodyLen u32
    body[46] = 0x80;
    body[47] = 0x80;
    expect(() => decodeForumContents(body)).toThrow();
  });
});
