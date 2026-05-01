/**
 * Canonical post manifest. Single source of truth for:
 *
 *   - the set of slugs the widget will accept comments under
 *     (consumed by `src/widget/post-id.ts` to build `KNOWN_POST_IDS`),
 *   - the order and titles rendered on `posts/index.html` (currently
 *     hand-authored and hand-synced; the fixture test in
 *     `test/post-fixtures.test.ts` enforces the sync).
 *
 * The 5 entries below are the 5 most recent posts on
 * <https://github.com/vbuterin/blog> at the time of authoring
 * (May 2026). Bodies in `posts/<slug>.html` are short verbatim
 * excerpts; each links to the canonical post on
 * vitalik.eth.limo. The point of the demo is the comments
 * section, not the article text.
 */

export interface PostMeta {
  /** URL slug; matches `posts/<slug>.html` and `data-post-slug=`. */
  readonly slug: string;
  readonly title: string;
  /** ISO date `YYYY-MM-DD`. */
  readonly date: string;
  /** Canonical source URL on the live blog. */
  readonly canonicalUrl: string;
}

export const POSTS: readonly PostMeta[] = [
  {
    slug: 'secure-llms',
    title: 'My self-sovereign / local / private / secure LLM setup, April 2026',
    date: '2026-04-02',
    canonicalUrl: 'https://vitalik.eth.limo/general/2026/04/02/secure_llms.html',
  },
  {
    slug: 'balance-of-power',
    title: 'Balance of power',
    date: '2025-12-30',
    canonicalUrl:
      'https://vitalik.eth.limo/general/2025/12/30/balance_of_power.html',
  },
  {
    slug: 'societies',
    title: 'Let a thousand societies bloom',
    date: '2025-12-17',
    canonicalUrl: 'https://vitalik.eth.limo/general/2025/12/17/societies.html',
  },
  {
    slug: 'plinko',
    title: 'Plinko PIR tutorial',
    date: '2025-11-25',
    canonicalUrl: 'https://vitalik.eth.limo/general/2025/11/25/plinko.html',
  },
  {
    slug: 'galaxybrain',
    title: 'Galaxy brain resistance',
    date: '2025-11-07',
    canonicalUrl: 'https://vitalik.eth.limo/general/2025/11/07/galaxybrain.html',
  },
];
