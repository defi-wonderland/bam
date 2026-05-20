import type { Bytes32 } from 'bam-sdk';

import type { ValidationResult } from '../types.js';

/**
 * Content-tag authority check.
 *
 * After the tag-binding rework, `contentTag` is bound into the
 * `messageHash` formula directly — an attacker who captures a
 * `(sender, nonce, contents, sig)` signed for tag A cannot re-attribute
 * it to tag B because the verifier would reconstruct `messageHash`
 * with tag B and fail the signature check. So this stage no longer
 * cross-checks `contents[0..32]` against the envelope tag (the body
 * carries no tag prefix any more); it only enforces the operator's
 * allowlist on the envelope-level tag, ahead of any crypto.
 */
export function checkContentTag(
  envelopeTag: Bytes32,
  allowlist: readonly Bytes32[]
): ValidationResult {
  if (!allowlist.some((t) => bytes32Equal(envelopeTag, t))) {
    return { ok: false, reason: 'unknown_tag' };
  }
  return { ok: true };
}

function bytes32Equal(a: Bytes32, b: Bytes32): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
