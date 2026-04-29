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

export const SEPOLIA_CHAIN_ID = 11155111;
export const MAX_POST_CHARS = 280;
