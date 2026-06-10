/**
 * Server-side decoder wrapping `bam-sdk/forum`'s `decodeForumContents`.
 *
 * The reader returns `contents` as `0x`-prefixed hex; we decode once on
 * the server and ship a typed payload to the client so it never sees
 * the wire format.
 */

import { decodeForumContents, type ForumPayload } from 'bam-sdk/forum';
import { hexToBytes } from 'bam-sdk/browser';

/**
 * Decode a `0x`-hex `contents` field. Returns `null` on any malformed
 * input — caller skips the row rather than tearing the whole feed.
 */
export function decodeForumContentsHex(hex: string): ForumPayload | null {
  try {
    const bytes = hexToBytes(hex);
    return decodeForumContents(bytes);
  } catch {
    return null;
  }
}

const tagDecoder = new TextDecoder('utf-8', { fatal: false });

/** UTF-8-decode a post's `tag` (≤32 bytes). Non-UTF-8 bytes render as `'�'`. */
export function decodeTagBytes(tag: Uint8Array): string {
  if (tag.byteLength === 0) return '';
  return tagDecoder.decode(tag);
}
