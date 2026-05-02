/**
 * Per-post identifier the comments widget uses to scope a thread
 * to one post on one site. The on-chain `contentTag` is single
 * (`bam-blog.v1`) for every embed of this widget; per-post
 * separation lives **inside** the signed `contents` payload, so
 * a relay cannot re-attribute a comment to a different post (or
 * site) without breaking the message signature.
 *
 * Preimage layout for `keccak256`:
 *
 *     contentTag (32B) ‖ uint16BE(len(siteId)) ‖ utf8(siteId) ‖
 *                       uint16BE(len(postId)) ‖ utf8(postId)
 *
 * Why each piece:
 *   - **contentTag** as a domain separator. A fork that picks a
 *     different `contentTag` automatically gets a disjoint
 *     post-id space, even with identical (siteId, postId).
 *   - **siteId** isolates a thread to one site. Auto-derived from
 *     `window.location.hostname` at the embed point, with an
 *     optional `data-site-id="…"` override on the mount node.
 *     Lowercased before hashing (DNS hostnames are case-insensitive;
 *     this avoids a casing footgun).
 *   - **postId** is whatever the host put in `data-post-id`.
 *   - **Length-prefix** so different (siteId, postId) splits can't
 *     collide on a shared concatenation.
 *
 * Two sites accidentally picking the same `data-post-id="my-post"`
 * see independent threads as long as their `siteId` differs.
 * Hosts who care about subdomain unification (`www.x.com` vs
 * `x.com`) should pin `data-site-id` explicitly on every page.
 */

import { keccak256, type Hex } from 'viem';

import { BLOG_DEMO_CONTENT_TAG } from './content-tag.js';

const CONTENT_TAG_BYTES = hexToBytes(BLOG_DEMO_CONTENT_TAG);
const MAX_FIELD_BYTES = 0xffff;

const textEncoder = new TextEncoder();

export function derivePostIdHash(args: {
  siteId: string;
  postId: string;
}): Hex {
  const siteBytes = textEncoder.encode(args.siteId.toLowerCase());
  const postBytes = textEncoder.encode(args.postId);
  if (args.siteId.length === 0) {
    throw new RangeError('siteId must be non-empty');
  }
  if (args.postId.length === 0) {
    throw new RangeError('postId must be non-empty');
  }
  if (siteBytes.length > MAX_FIELD_BYTES) {
    throw new RangeError(`siteId longer than ${MAX_FIELD_BYTES} bytes`);
  }
  if (postBytes.length > MAX_FIELD_BYTES) {
    throw new RangeError(`postId longer than ${MAX_FIELD_BYTES} bytes`);
  }

  const buf = new Uint8Array(
    32 + 2 + siteBytes.length + 2 + postBytes.length
  );
  let o = 0;
  buf.set(CONTENT_TAG_BYTES, o);
  o += 32;
  buf[o++] = (siteBytes.length >> 8) & 0xff;
  buf[o++] = siteBytes.length & 0xff;
  buf.set(siteBytes, o);
  o += siteBytes.length;
  buf[o++] = (postBytes.length >> 8) & 0xff;
  buf[o++] = postBytes.length & 0xff;
  buf.set(postBytes, o);
  return keccak256(buf);
}

/**
 * Resolves the effective `siteId` for a mount: the explicit
 * `data-site-id` attribute if present, else
 * `window.location.hostname`. Lowercased.
 *
 * Falls back to the literal string `"unknown"` only if both are
 * unavailable (e.g., a unit-test environment without `window`).
 * Hosts who care about hostname stability should set
 * `data-site-id` explicitly so dev / preview / prod all derive
 * the same hash.
 */
export function resolveSiteId(mount: HTMLElement): string {
  const explicit = mount.getAttribute('data-site-id');
  if (explicit !== null && explicit.length > 0) {
    return explicit.toLowerCase();
  }
  const host =
    typeof window !== 'undefined' && window.location?.hostname
      ? window.location.hostname.toLowerCase()
      : '';
  return host.length > 0 ? host : 'unknown';
}

function hexToBytes(hex: string): Uint8Array {
  const c = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(c.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(c.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
