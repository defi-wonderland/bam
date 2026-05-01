/**
 * Per-post identifier the comments widget uses to scope a thread to
 * its post. The on-chain `contentTag` is single per app
 * (`bam-blog-demo.v1`); per-post separation lives **inside** the
 * signed `contents` payload, so a relay cannot re-attribute a
 * comment to a different post without breaking the message
 * signature.
 *
 * The hash is `keccak256(utf8(NAMESPACE + ':' + slug))`. Slug is
 * the URL slug (`possible-futures-merge`, `glue-coprocessor`, …)
 * and matches `posts/<slug>.html`.
 *
 * `KNOWN_POST_IDS` is built once at module load from the manifest
 * in `posts/_slugs.ts` and is used by the thread builder to drop
 * confirmed comments whose post id matches none of the demo's
 * posts (a closed set, by design).
 */

import { keccak256, toBytes, type Hex } from 'viem';

import { POSTS } from '../../posts/_slugs.js';

export const POST_ID_NAMESPACE = 'bam-blog-demo.v1';

/**
 * Returns the bytes32 post id for `slug`.
 * Throws if `slug` is empty.
 */
export function slugToPostIdHash(slug: string): Hex {
  if (slug.length === 0) {
    throw new RangeError('slug must be non-empty');
  }
  return keccak256(toBytes(`${POST_ID_NAMESPACE}:${slug}`));
}

/** `postIdHash` (lowercased) → slug, for every demo post. */
export const KNOWN_POST_IDS: ReadonlyMap<Hex, string> = (() => {
  const map = new Map<Hex, string>();
  for (const { slug } of POSTS) {
    const hash = slugToPostIdHash(slug).toLowerCase() as Hex;
    if (map.has(hash)) {
      // Caught at module load — fixture authoring bug.
      throw new Error(`duplicate postIdHash for slug ${slug}`);
    }
    map.set(hash, slug);
  }
  return map;
})();

/**
 * Returns the slug for `postIdHash` if it belongs to a known post,
 * else `null`. Case-insensitive on the hash.
 */
export function postIdHashToSlug(postIdHash: Hex): string | null {
  return KNOWN_POST_IDS.get(postIdHash.toLowerCase() as Hex) ?? null;
}
