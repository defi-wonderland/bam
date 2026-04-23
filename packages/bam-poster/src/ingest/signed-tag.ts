import type { Bytes32 } from 'bam-sdk';

import type { ValidationResult } from '../types.js';

/**
 * Signed-tag authority check (plan §B-1 / spec Goals).
 *
 * The `contentTag` bound inside the signed message payload is the
 * authoritative source for every ingest decision. Any transport-layer
 * hint is advisory; disagreement rejects before the validator runs.
 *
 * The allowlist check uses the *signed* tag; a rogue hint cannot drag
 * an unknown tag through an allowlisted path.
 */
export function checkSignedTag(
  signedTag: Bytes32,
  hintTag: Bytes32 | undefined,
  allowlist: readonly Bytes32[]
): ValidationResult {
  if (hintTag !== undefined && !bytes32Equal(signedTag, hintTag)) {
    return { ok: false, reason: 'content_tag_mismatch' };
  }
  if (!allowlist.some((t) => bytes32Equal(signedTag, t))) {
    return { ok: false, reason: 'unknown_tag' };
  }
  return { ok: true };
}

function bytes32Equal(a: Bytes32, b: Bytes32): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
