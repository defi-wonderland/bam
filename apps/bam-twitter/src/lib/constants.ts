/**
 * Per-app ERC-8179 contentTag. Precomputed `keccak256(utf8("bam-twitter.v1"))`.
 *
 * The shared Poster + Reader filter on this tag, so picking a tag
 * distinct from every other app sharing the BAM core deployment is
 * how we get an isolated feed without standing up a second Poster /
 * Reader. The literal is hardcoded so this module stays free of viem
 * / @noble imports — the constants module is reachable from the
 * client bundle.
 */
export const TWITTER_TAG =
  '0xf0fea94ffd2ae32ed878c57e3427bbffab46d333d09837bc640d952795090718' as const;

/**
 * Other content tags this app needs to be aware of when computing a
 * sender's next nonce.
 *
 * The Poster's nonce monotonicity check is **per sender across all
 * tags** (see `packages/bam-poster/src/ingest/monotonicity.ts:11`).
 * If we estimated `max(nonce)+1` from only the Twitter feed, a user
 * who first posted in another app on the same Poster would compute a
 * stale nonce, get rejected, and live-lock on retry. Until the
 * Poster grows a `/nonce/:sender` endpoint we union the confirmed
 * views across known tags. New apps sharing this Poster need to be
 * added here — explicit list, not auto-discovery.
 */
export const MESSAGE_IN_A_BLOBBLE_TAG =
  '0x323eee4675c068805a324c1a3a36805d446179434138f2f0872ac3f81b2e6591' as const;

/** `keccak256(utf8("bam-blog.v1"))` — see `apps/bam-blog-demo/src/widget/content-tag.ts`. */
export const BAM_BLOG_DEMO_TAG =
  '0xece35f4f2613ebd3630cf9589826bea0e719af7b937e1844faf22115152afc1a' as const;

export const KNOWN_CONTENT_TAGS = [
  TWITTER_TAG,
  MESSAGE_IN_A_BLOBBLE_TAG,
  BAM_BLOG_DEMO_TAG,
] as const;

export const SEPOLIA_CHAIN_ID = 11155111;
export const MAX_POST_CHARS = 280;
