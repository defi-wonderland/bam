import { describe, expect, it } from 'vitest';
import type { Bytes32 } from 'bam-sdk';

import { decodeSocialContents, encodeSocialContents } from '../../src/lib/contents-codec';

const TAG = ('0x' + 'aa'.repeat(32)) as Bytes32;

describe('encodeSocialContents / decodeSocialContents', () => {
  it('round-trips a plain ASCII message', () => {
    const encoded = encodeSocialContents(TAG, { timestamp: 1_700_000_000, content: 'hello world' });
    const decoded = decodeSocialContents(encoded);
    expect(decoded.contentTag.toLowerCase()).toBe(TAG.toLowerCase());
    expect(decoded.app).toEqual({ timestamp: 1_700_000_000, content: 'hello world' });
  });

  it('round-trips unicode (emoji + CJK)', () => {
    const msg = { timestamp: 1_800_000_000, content: '🐳 こんにちは' };
    const encoded = encodeSocialContents(TAG, msg);
    const decoded = decodeSocialContents(encoded);
    expect(decoded.app).toEqual(msg);
  });

  it('round-trips empty content', () => {
    const encoded = encodeSocialContents(TAG, { timestamp: 0, content: '' });
    const decoded = decodeSocialContents(encoded);
    expect(decoded.app).toEqual({ timestamp: 0, content: '' });
  });

  it('first 32 bytes of contents is the contentTag prefix', () => {
    const encoded = encodeSocialContents(TAG, { timestamp: 1, content: 'x' });
    const hexPrefix =
      '0x' +
      Array.from(encoded.slice(0, 32))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    expect(hexPrefix).toBe(TAG);
  });

  it('rejects a short buffer', () => {
    expect(() => decodeSocialContents(new Uint8Array(31))).toThrow();
  });

  it('rejects a buffer with a truncated app body', () => {
    const encoded = encodeSocialContents(TAG, { timestamp: 1, content: 'abc' });
    const truncated = encoded.slice(0, encoded.length - 1);
    expect(() => decodeSocialContents(truncated)).toThrow();
  });

  it('rejects an invalid-UTF8 body', () => {
    // Build a correctly-framed but invalid-UTF8 content body
    const body = new Uint8Array(12 + 2);
    body[8] = 0; body[9] = 0; body[10] = 0; body[11] = 2;
    body[12] = 0xff;
    body[13] = 0xfe;
    // encodeContents adds the tag prefix; we bypass it and build manually.
    const full = new Uint8Array(32 + body.length);
    for (let i = 0; i < 32; i++) full[i] = 0xaa;
    full.set(body, 32);
    expect(() => decodeSocialContents(full)).toThrow();
  });
});
