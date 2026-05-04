/**
 * The single ERC-8179 contentTag every bam-comments instance submits
 * under and filters reads against. Pre-derived from
 * `keccak256(utf8("bam-comments.v1"))` so this module ships zero
 * runtime hashing — the value is byte-pinned by content-tag.test.ts.
 *
 * Different BAM apps sharing the same Poster + Reader use distinct
 * contentTags to isolate their feeds. Cross-tag nonce coordination is
 * solved authoritatively by the Poster's `/nonce/<sender>` endpoint
 * (see ../poster-reader.ts), so no fan-out across sibling apps is
 * needed here.
 */

export const NAMESPACE = 'bam-comments.v1';

/**
 * `keccak256(utf8("bam-comments.v1"))`. Pinned in content-tag.test.ts
 * so a typo here surfaces as a test failure, not a silently
 * incompatible feed.
 */
export const BAM_COMMENTS_TAG =
  '0x74d06cf56cb55fea0e37cce28125ed572b2e9f936edcb161ee4138ed1620a512' as const;

export type ContentTagHex = typeof BAM_COMMENTS_TAG;
