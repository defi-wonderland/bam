import { describe, expect, it } from 'vitest';

import { decodeSocialContents, encodeSocialContents } from '../../src/lib/contents-codec';

describe('encodeSocialContents / decodeSocialContents', () => {
  it('round-trips a plain ASCII message', () => {
    const encoded = encodeSocialContents({ timestamp: 1_700_000_000, content: 'hello world' });
    const decoded = decodeSocialContents(encoded);
    expect(decoded).toEqual({ timestamp: 1_700_000_000, content: 'hello world' });
  });

  it('round-trips unicode (emoji + CJK)', () => {
    const msg = { timestamp: 1_800_000_000, content: '🐳 こんにちは' };
    const encoded = encodeSocialContents(msg);
    const decoded = decodeSocialContents(encoded);
    expect(decoded).toEqual(msg);
  });

  it('round-trips empty content', () => {
    const encoded = encodeSocialContents({ timestamp: 0, content: '' });
    const decoded = decodeSocialContents(encoded);
    expect(decoded).toEqual({ timestamp: 0, content: '' });
  });

  it('first 8 bytes are the BE-encoded timestamp', () => {
    const encoded = encodeSocialContents({ timestamp: 1, content: 'x' });
    // BE: 7 zero bytes then 0x01.
    expect(Array.from(encoded.slice(0, 8))).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
  });

  it('rejects a short buffer', () => {
    expect(() => decodeSocialContents(new Uint8Array(11))).toThrow();
  });

  it('rejects a buffer with a truncated app body', () => {
    const encoded = encodeSocialContents({ timestamp: 1, content: 'abc' });
    const truncated = encoded.slice(0, encoded.length - 1);
    expect(() => decodeSocialContents(truncated)).toThrow();
  });

  it('rejects an invalid-UTF8 body', () => {
    // Build a correctly-framed body with invalid UTF-8 content bytes.
    const body = new Uint8Array(12 + 2);
    body[8] = 0; body[9] = 0; body[10] = 0; body[11] = 2;
    body[12] = 0xff;
    body[13] = 0xfe;
    expect(() => decodeSocialContents(body)).toThrow();
  });
});
