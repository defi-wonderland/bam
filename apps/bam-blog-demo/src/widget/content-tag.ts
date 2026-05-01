/**
 * Per-app ERC-8179 contentTag for the blog comments demo.
 * Precomputed `keccak256(utf8("bam-blog-demo.v1"))`.
 *
 * The shared Poster + Reader filter on this tag, so picking a
 * tag distinct from every other app sharing the BAM core
 * deployment is how the demo gets an isolated feed without
 * standing up a second Poster / Reader. The literal is
 * hardcoded so this module stays free of viem / @noble imports
 * — it's reachable from the bundled widget.
 *
 * The pin in `test/content-tag.test.ts` enforces consistency
 * with the namespace string the codec and post-id modules
 * derive their hashes from.
 */

export const CONTENT_TAG_NAMESPACE = 'bam-blog-demo.v1';

export const BLOG_DEMO_CONTENT_TAG =
  '0xafe64111cc3b6a387f1cf4d4deb29d300bebc1748ff4d039459a6af86c6dab4b' as const;

export const SEPOLIA_CHAIN_ID = 11155111;

export const MAX_COMMENT_CHARS = 280;
