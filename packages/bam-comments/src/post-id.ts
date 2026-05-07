/**
 * Site + post identification. The pair `(siteId, postId)` is what the
 * widget uses to bucket comments into a thread; `postIdHash` is the
 * 32-byte digest threaded through the signed contents payload (it is
 * NOT the on-chain ERC-8179 contentTag — that's `BAM_COMMENTS_TAG`).
 *
 * Layout fed to keccak256:
 *
 *   contentTag (32B)
 *   ‖ uint16BE(len(siteIdBytes)) ‖ utf8(siteId.toLowerCase())
 *   ‖ uint16BE(len(postIdBytes)) ‖ utf8(postId)
 *
 * Length-prefixing is essential — `("ab","cd")` would collide with
 * `("abc","d")` under naive concatenation. Pinned by post-id.test.ts.
 *
 * `siteId` is a DNS-style identifier (case-insensitive, lowercased
 * before hashing); `postId` is host-controlled and case-sensitive
 * (treated as opaque bytes).
 */

import { keccak256 as viemKeccak256 } from 'viem';

import type { ContentTagHex } from './content-tag.js';
import { hexToBytes } from './hex.js';

export type Bytes32Hex = `0x${string}`;

/**
 * Resolve the effective siteId for a mounted node. Falls back to
 * `window.location.hostname.toLowerCase()` when no `data-site-id` is
 * provided so a single-site host doesn't have to thread the override
 * through every embed snippet.
 *
 * Throws when neither override nor a hostname is available; comments
 * cannot be bucketed without a stable site identifier.
 */
export function resolveSiteId(
  override: string | null | undefined,
  hostname: string
): string {
  const raw = (override ?? hostname).trim().toLowerCase();
  if (raw === '') {
    throw new RangeError('siteId is required (no data-site-id and empty hostname)');
  }
  return raw;
}

/**
 * Compute `postIdHash` for a `(siteId, postId)` pair.
 *
 * `siteId` is lowercased before hashing (DNS-style case-insensitive);
 * `postId` is taken byte-for-byte (host-controlled, case-sensitive).
 * Both must be non-empty.
 */
export function derivePostIdHash(
  contentTag: ContentTagHex,
  siteId: string,
  postId: string
): Bytes32Hex {
  if (siteId.length === 0) {
    throw new RangeError('siteId must not be empty');
  }
  if (postId.length === 0) {
    throw new RangeError('postId must not be empty');
  }

  const tagBytes = hexToBytes(contentTag);
  if (tagBytes.length !== 32) {
    throw new RangeError(`contentTag must be 32 bytes, got ${tagBytes.length}`);
  }

  const enc = new TextEncoder();
  const siteBytes = enc.encode(siteId.toLowerCase());
  const postBytes = enc.encode(postId);
  if (siteBytes.length > 0xffff) {
    throw new RangeError('siteId too long for uint16 length prefix');
  }
  if (postBytes.length > 0xffff) {
    throw new RangeError('postId too long for uint16 length prefix');
  }

  const total = 32 + 2 + siteBytes.length + 2 + postBytes.length;
  const buf = new Uint8Array(total);
  let off = 0;
  buf.set(tagBytes, off);
  off += 32;
  buf[off++] = (siteBytes.length >>> 8) & 0xff;
  buf[off++] = siteBytes.length & 0xff;
  buf.set(siteBytes, off);
  off += siteBytes.length;
  buf[off++] = (postBytes.length >>> 8) & 0xff;
  buf[off++] = postBytes.length & 0xff;
  buf.set(postBytes, off);

  return viemKeccak256(buf) as Bytes32Hex;
}
