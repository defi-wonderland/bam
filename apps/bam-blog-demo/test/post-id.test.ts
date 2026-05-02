/**
 * Pins the new post-id derivation and the per-(site, post) hashes
 * the demo's pages produce. If any of these change, comments
 * authored before the change become invisible to the new code
 * (the hash inside their signed `contents` no longer matches what
 * the widget computes for the mount), so the pinned table is the
 * regression guard.
 */

import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';

import { derivePostIdHash, resolveSiteId } from '../src/widget/post-id.js';

const DEMO_SITE = 'bam-blog-demo';

const PINNED: Record<string, Hex> = {
  'secure-llms':
    '0xa9416e37e9366296b230b33181b98b2b8c18d5bdf6e3bbcb09b15fbbf95cd648',
  'balance-of-power':
    '0xd72c1df9992c56a763e64262dad7356825ebd0fc603982b3ede430ee6af33f21',
  societies:
    '0x3f50bbdc394cc70340f4b183ca0986b43916cddb69a31447fd496b6d7dbd72f3',
  plinko:
    '0x2f4c621531bb48ead455f0d5ce2c530bb5f7232808362504ee3c232f5704ae94',
  galaxybrain:
    '0x9b6d8a8b8d6ea124a2c0d7ae5aa3d2aa01f613a0cb0458ff28cb6d495264acba',
};

describe('derivePostIdHash', () => {
  it('matches the pinned hash for every demo (siteId, postId) pair', () => {
    for (const [postId, pinned] of Object.entries(PINNED)) {
      expect(derivePostIdHash({ siteId: DEMO_SITE, postId }).toLowerCase()).toBe(
        pinned
      );
    }
  });

  it('the same postId on a different site produces a different hash', () => {
    const a = derivePostIdHash({ siteId: 'site-a.com', postId: 'my-post' });
    const b = derivePostIdHash({ siteId: 'site-b.com', postId: 'my-post' });
    expect(a).not.toBe(b);
  });

  it('siteId is case-insensitive (DNS hostname semantics)', () => {
    const a = derivePostIdHash({ siteId: 'Example.COM', postId: 'p' });
    const b = derivePostIdHash({ siteId: 'example.com', postId: 'p' });
    expect(a).toBe(b);
  });

  it('postId is case-sensitive (host-controlled, opaque)', () => {
    const a = derivePostIdHash({ siteId: 'x', postId: 'My-Post' });
    const b = derivePostIdHash({ siteId: 'x', postId: 'my-post' });
    expect(a).not.toBe(b);
  });

  it('rejects empty siteId and empty postId', () => {
    expect(() => derivePostIdHash({ siteId: '', postId: 'p' })).toThrow();
    expect(() => derivePostIdHash({ siteId: 's', postId: '' })).toThrow();
  });

  it('length-prefixing prevents (siteId, postId) split collisions', () => {
    // Without length-prefix, ("ab", "cd") and ("abc", "d") would
    // hash the same concatenation. With it, they don't.
    const left = derivePostIdHash({ siteId: 'ab', postId: 'cd' });
    const right = derivePostIdHash({ siteId: 'abc', postId: 'd' });
    expect(left).not.toBe(right);
  });
});

describe('resolveSiteId', () => {
  function fakeMount(attrs: Record<string, string> = {}): HTMLElement {
    const node: Partial<HTMLElement> = {
      getAttribute: (name: string) => attrs[name] ?? null,
    };
    return node as HTMLElement;
  }

  it('returns the data-site-id attribute when present, lowercased', () => {
    expect(resolveSiteId(fakeMount({ 'data-site-id': 'My-Site.com' }))).toBe(
      'my-site.com'
    );
  });

  it('falls back to a non-empty default when no attribute and no window', () => {
    // In the vitest node env, `window` is absent; the helper
    // should still produce a string, not throw.
    const out = resolveSiteId(fakeMount());
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
  });
});
