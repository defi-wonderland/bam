import { describe, it, expect } from 'vitest';
import { keccak256 } from 'viem';

import { BAM_COMMENTS_TAG } from '../src/content-tag.js';
import { derivePostIdHash, resolveSiteId } from '../src/post-id.js';
import { hexToBytes } from '../src/hex.js';

/**
 * Reference implementation matching the spec's byte layout:
 *
 *   contentTag (32B)
 *   ‖ uint16BE(len(siteIdBytes)) ‖ utf8(siteId.toLowerCase())
 *   ‖ uint16BE(len(postIdBytes)) ‖ utf8(postId)
 *
 * Used to pin five representative pairs.
 */
function refDerive(
  tag: `0x${string}`,
  siteId: string,
  postId: string
): `0x${string}` {
  const tagBytes = hexToBytes(tag);
  const siteBytes = new TextEncoder().encode(siteId.toLowerCase());
  const postBytes = new TextEncoder().encode(postId);
  const buf = new Uint8Array(32 + 2 + siteBytes.length + 2 + postBytes.length);
  let off = 0;
  buf.set(tagBytes, off);
  off += 32;
  buf[off++] = (siteBytes.length >>> 8) & 0xff;
  buf[off++] = siteBytes.length & 0xff;
  buf.set(siteBytes, off);
  off += siteBytes.length;
  buf[off++] = (postBytes.length >>> 8) & 0xff;
  buf[off++] = postBytes.length & 0xff;
  buf.set(postBytes, off);
  return keccak256(buf);
}

describe('post-id', () => {
  describe('derivePostIdHash', () => {
    const fixtures: Array<{ site: string; post: string }> = [
      { site: 'bam-comments-demo', post: 'post-1' },
      { site: 'bam-comments-demo', post: 'post-2' },
      { site: 'wonderland.dev', post: 'why-bam' },
      { site: 'example.com', post: 'a' },
      { site: 'example.com', post: '日本語-😀' },
    ];

    for (const { site, post } of fixtures) {
      it(`pins (${site}, ${post}) against the reference layout`, () => {
        const got = derivePostIdHash(BAM_COMMENTS_TAG, site, post);
        const ref = refDerive(BAM_COMMENTS_TAG, site, post);
        expect(got).toBe(ref);
      });
    }

    it('isolates the same postId across distinct sites', () => {
      const a = derivePostIdHash(BAM_COMMENTS_TAG, 'a.example', 'shared');
      const b = derivePostIdHash(BAM_COMMENTS_TAG, 'b.example', 'shared');
      expect(a).not.toBe(b);
    });

    it('treats siteId as case-insensitive (DNS semantics)', () => {
      const lower = derivePostIdHash(BAM_COMMENTS_TAG, 'example.com', 'p');
      const upper = derivePostIdHash(BAM_COMMENTS_TAG, 'EXAMPLE.COM', 'p');
      const mixed = derivePostIdHash(BAM_COMMENTS_TAG, 'Example.Com', 'p');
      expect(upper).toBe(lower);
      expect(mixed).toBe(lower);
    });

    it('treats postId as case-sensitive', () => {
      const lower = derivePostIdHash(BAM_COMMENTS_TAG, 'example.com', 'post');
      const upper = derivePostIdHash(BAM_COMMENTS_TAG, 'example.com', 'POST');
      expect(lower).not.toBe(upper);
    });

    it('length-prefixing prevents collision between ("ab","cd") and ("abc","d")', () => {
      const a = derivePostIdHash(BAM_COMMENTS_TAG, 'ab', 'cd');
      const b = derivePostIdHash(BAM_COMMENTS_TAG, 'abc', 'd');
      expect(a).not.toBe(b);
    });

    it('rejects empty siteId', () => {
      expect(() => derivePostIdHash(BAM_COMMENTS_TAG, '', 'p')).toThrow();
    });

    it('rejects empty postId', () => {
      expect(() => derivePostIdHash(BAM_COMMENTS_TAG, 'example.com', '')).toThrow();
    });

    it('rejects non-32-byte contentTag', () => {
      // Cast through `unknown` because the parameter is the literal
      // `BAM_COMMENTS_TAG` type; this test exercises the runtime
      // length guard, which has to remain even in cases the type
      // system would otherwise have ruled out.
      expect(() =>
        derivePostIdHash(
          '0xdead' as unknown as typeof BAM_COMMENTS_TAG,
          'example.com',
          'p'
        )
      ).toThrow();
    });
  });

  describe('resolveSiteId', () => {
    it('uses override when present', () => {
      expect(resolveSiteId('Bam-Comments-Demo', 'host.example')).toBe(
        'bam-comments-demo'
      );
    });

    it('falls back to hostname when override is absent', () => {
      expect(resolveSiteId(null, 'Host.Example')).toBe('host.example');
      expect(resolveSiteId(undefined, 'Host.Example')).toBe('host.example');
    });

    it('lowercases the result either way', () => {
      expect(resolveSiteId('UPPER.CASE', '')).toBe('upper.case');
    });

    it('throws when both override and hostname are empty', () => {
      expect(() => resolveSiteId(null, '')).toThrow();
      expect(() => resolveSiteId('', '   ')).toThrow();
    });
  });
});
