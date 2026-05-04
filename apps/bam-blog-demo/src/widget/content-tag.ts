/**
 * Per-app ERC-8179 contentTag for the blog comments demo.
 * Precomputed `keccak256(utf8("bam-blog.v1"))`.
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

export const CONTENT_TAG_NAMESPACE = 'bam-blog.v1';

export const BLOG_DEMO_CONTENT_TAG =
  '0xece35f4f2613ebd3630cf9589826bea0e719af7b937e1844faf22115152afc1a' as const;

export const SEPOLIA_CHAIN_ID = 11155111;

export const MAX_COMMENT_CHARS = 280;
