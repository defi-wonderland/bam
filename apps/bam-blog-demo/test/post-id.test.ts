/**
 * Pins the namespace string and the per-slug postIdHash values that
 * the demo's widget uses for per-post scoping. If any of these
 * change, the comments under existing confirmed messages would
 * silently disappear (the new hash wouldn't match the old payload).
 * The pinned table is the regression guard.
 */

import { describe, it, expect } from 'vitest';
import { keccak256, toBytes } from 'viem';

import {
  KNOWN_POST_IDS,
  POST_ID_NAMESPACE,
  postIdHashToSlug,
  slugToPostIdHash,
} from '../src/widget/post-id.js';

const PINNED: Record<string, `0x${string}`> = {
  'secure-llms':
    '0x21c2b8410a883bb4e6b839335a033e843ec096d49db34d824384ff7df62b2897',
  'balance-of-power':
    '0x96bb94efa50808cd4212ab11d14930d45244cc37eb01173ff1af61c8685497a4',
  societies:
    '0xe2373ef954935f13aee50eaada57bf5ccdad4886b2beab2f940e7e4e584186e2',
  plinko:
    '0xc3929321af2b67eb9fa9ad01044f387d4e32872ec86ff6bf5f6327c222756f55',
  galaxybrain:
    '0x7e87bafe0d063dc325059b2e414dfbbcb14e070a3badff531872864faffe7438',
};

describe('post-id', () => {
  it('namespace is the v1 string', () => {
    expect(POST_ID_NAMESPACE).toBe('bam-blog.v1');
  });

  it('matches the spec formula keccak256(NAMESPACE + ":" + slug)', () => {
    for (const [slug, pinned] of Object.entries(PINNED)) {
      expect(
        keccak256(toBytes(`${POST_ID_NAMESPACE}:${slug}`)).toLowerCase(),
        `formula mismatch for ${slug}`
      ).toBe(pinned);
    }
  });

  it('slugToPostIdHash returns the pinned hash for every known slug', () => {
    for (const [slug, pinned] of Object.entries(PINNED)) {
      expect(slugToPostIdHash(slug).toLowerCase()).toBe(pinned);
    }
  });

  it('rejects an empty slug', () => {
    expect(() => slugToPostIdHash('')).toThrow(RangeError);
  });

  it('KNOWN_POST_IDS contains exactly the 5 pinned hashes', () => {
    expect(KNOWN_POST_IDS.size).toBe(5);
    for (const [slug, pinned] of Object.entries(PINNED)) {
      expect(KNOWN_POST_IDS.get(pinned)).toBe(slug);
    }
  });

  it('postIdHashToSlug round-trips and is case-insensitive', () => {
    for (const [slug, pinned] of Object.entries(PINNED)) {
      expect(postIdHashToSlug(pinned)).toBe(slug);
      expect(postIdHashToSlug(pinned.toUpperCase() as `0x${string}`)).toBe(slug);
    }
  });

  it('postIdHashToSlug returns null for an unknown hash', () => {
    expect(
      postIdHashToSlug(
        '0x0000000000000000000000000000000000000000000000000000000000000000'
      )
    ).toBeNull();
  });
});
