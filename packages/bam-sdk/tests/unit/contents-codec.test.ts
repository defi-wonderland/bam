import { describe, expect, it } from 'vitest';

import type { Bytes32 } from '../../src/types.js';
import { ContentsTooShortError } from '../../src/errors.js';
import { encodeContents, splitContents } from '../../src/message.js';

describe('encodeContents / splitContents round-trip', () => {
  it('zero-length app bytes', () => {
    const tag = ('0x' + 'aa'.repeat(32)) as Bytes32;
    const app = new Uint8Array(0);
    const contents = encodeContents(tag, app);
    expect(contents.length).toBe(32);
    const split = splitContents(contents);
    expect(split.contentTag).toBe(tag);
    expect(split.appBytes.length).toBe(0);
  });

  it('arbitrary lengths round-trip', () => {
    const tag = ('0x' + 'bb'.repeat(32)) as Bytes32;
    for (const n of [1, 2, 31, 32, 64, 100, 257, 1024]) {
      const app = new Uint8Array(n);
      for (let i = 0; i < n; i++) app[i] = (i * 7 + 13) & 0xff;
      const contents = encodeContents(tag, app);
      expect(contents.length).toBe(32 + n);
      const split = splitContents(contents);
      expect(split.contentTag).toBe(tag);
      expect(split.appBytes.length).toBe(n);
      expect(Array.from(split.appBytes)).toEqual(Array.from(app));
    }
  });

  it('splitContents throws ContentsTooShortError on short buffer', () => {
    expect(() => splitContents(new Uint8Array(31))).toThrow(ContentsTooShortError);
    expect(() => splitContents(new Uint8Array(0))).toThrow(ContentsTooShortError);
    expect(() => splitContents(new Uint8Array(1))).toThrow(ContentsTooShortError);
  });

  it('ContentsTooShortError carries the actual length', () => {
    try {
      splitContents(new Uint8Array(7));
    } catch (err) {
      expect(err).toBeInstanceOf(ContentsTooShortError);
      expect((err as ContentsTooShortError).details).toEqual({ actualBytes: 7 });
      return;
    }
    throw new Error('expected throw');
  });

  it('encodeContents rejects non-32-byte tag', () => {
    const shortTag = ('0x1234') as Bytes32;
    expect(() => encodeContents(shortTag, new Uint8Array(0))).toThrow(RangeError);
  });

  it('splitContents at exact 32 bytes yields empty appBytes', () => {
    const tag = ('0x' + 'cd'.repeat(32)) as Bytes32;
    const contents = encodeContents(tag, new Uint8Array(0));
    const split = splitContents(contents);
    expect(split.appBytes.length).toBe(0);
  });
});
