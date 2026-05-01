/**
 * Pins `BLOG_DEMO_CONTENT_TAG` to `keccak256(utf8(CONTENT_TAG_NAMESPACE))`.
 *
 * This is the cross-app coordination point: bumping the namespace
 * (or the hash) without updating
 * `apps/bam-twitter/src/lib/constants.ts` `KNOWN_CONTENT_TAGS`
 * desynchronizes the per-sender nonce computation. The pin is the
 * regression guard.
 */

import { describe, expect, it } from 'vitest';
import { keccak256, toBytes } from 'viem';

import {
  BLOG_DEMO_CONTENT_TAG,
  CONTENT_TAG_NAMESPACE,
} from '../src/widget/content-tag.js';

describe('content-tag', () => {
  it('namespace is the v1 string', () => {
    expect(CONTENT_TAG_NAMESPACE).toBe('bam-blog-demo.v1');
  });

  it('BLOG_DEMO_CONTENT_TAG matches keccak256(utf8(NAMESPACE))', () => {
    expect(BLOG_DEMO_CONTENT_TAG.toLowerCase()).toBe(
      keccak256(toBytes(CONTENT_TAG_NAMESPACE)).toLowerCase()
    );
  });

  it('BLOG_DEMO_CONTENT_TAG is the pinned bytes32 literal', () => {
    expect(BLOG_DEMO_CONTENT_TAG.toLowerCase()).toBe(
      '0xafe64111cc3b6a387f1cf4d4deb29d300bebc1748ff4d039459a6af86c6dab4b'
    );
  });

  it('BLOG_DEMO_CONTENT_TAG is 32 bytes (66-char 0x-prefixed hex)', () => {
    expect(BLOG_DEMO_CONTENT_TAG).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
