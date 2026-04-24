import type { Bytes32 } from 'bam-sdk';

import type { ValidationResult } from '../types.js';

/**
 * Content-tag authority check.
 *
 * The authoritative `contentTag` is `contents[0..32]` — those bytes
 * are part of the message the signer signed over, so re-attributing
 * a captured signed message to a different tag is impossible without
 * invalidating the signature. The envelope's top-level `contentTag`
 * is a routing hint only; this stage rejects any mismatch between
 * the hint and the signed prefix before signature verification runs.
 *
 * Also enforces the operator's allowlist: the signed prefix must be
 * on the allowed tags. An allowlisted tag that mismatches the hint
 * still rejects as `content_tag_mismatch` (the hint is the caller's
 * bug); a matching pair where the tag isn't on the allowlist rejects
 * as `unknown_tag`.
 */
export function checkContentTag(
  envelopeTag: Bytes32,
  contents: Uint8Array,
  allowlist: readonly Bytes32[]
): ValidationResult {
  if (contents.length < 32) {
    // Parser should have caught this — double-check before slicing.
    return { ok: false, reason: 'malformed' };
  }
  const signedTag = bytesToBytes32(contents.subarray(0, 32));
  if (!bytes32Equal(signedTag, envelopeTag)) {
    return { ok: false, reason: 'content_tag_mismatch' };
  }
  if (!allowlist.some((t) => bytes32Equal(signedTag, t))) {
    return { ok: false, reason: 'unknown_tag' };
  }
  return { ok: true };
}

function bytesToBytes32(bytes: Uint8Array): Bytes32 {
  return ('0x' +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')) as Bytes32;
}

function bytes32Equal(a: Bytes32, b: Bytes32): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
