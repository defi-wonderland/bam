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
    '0x40a0424bf67a54fd4c2d7f7401bbd9654a68010ddc4c1c2f34deb6a15b038d88',
  'balance-of-power':
    '0x9e505f5876eb2de178d906ba88db9a056b47ca34780639858087ba1b320dc83b',
  societies:
    '0x0501f43f5aaa41d4ccaf0d3abb9dedd6da901d9f1510deb4be54d466146da50f',
  plinko:
    '0xd730893ef63c900a32eb6f04f109ea52503af60acb33064c4123db4fdb0b5baf',
  galaxybrain:
    '0xa75cec610ade5eaf5860faa186320753189f7b92d1af417cfa9c4ae45c8ba5b9',
};

describe('post-id', () => {
  it('namespace is the v1 string', () => {
    expect(POST_ID_NAMESPACE).toBe('bam-blog-demo.v1');
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
