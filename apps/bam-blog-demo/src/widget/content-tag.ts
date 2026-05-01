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

/**
 * Tags we walk when computing per-sender next-nonce. The Poster's
 * monotonicity check is per sender across all tags
 * (`packages/bam-poster/src/ingest/monotonicity.ts`), so a per-tag
 * estimate would live-lock any wallet that has posted in another
 * app on the same Poster. Mirror of
 * `apps/bam-twitter/src/lib/constants.ts` `KNOWN_CONTENT_TAGS`.
 *
 * Only consulted in static-deploy mode, where the widget
 * computes next-nonce client-side. In proxy mode `server.ts`
 * carries the same list and does the walk server-side.
 */
export const KNOWN_CONTENT_TAGS = [
  '0xf0fea94ffd2ae32ed878c57e3427bbffab46d333d09837bc640d952795090718', // bam-twitter.v1
  '0x323eee4675c068805a324c1a3a36805d446179434138f2f0872ac3f81b2e6591', // message-in-a-blobble.v1
  BLOG_DEMO_CONTENT_TAG,
] as const;
