import { describe, it, expect } from 'vitest';
import type { Bytes32 } from 'bam-sdk';

import { checkSignedTag } from '../../src/ingest/signed-tag.js';

const TAG_A = ('0x' + 'aa'.repeat(32)) as Bytes32;
const TAG_B = ('0x' + 'bb'.repeat(32)) as Bytes32;
const TAG_C = ('0x' + 'cc'.repeat(32)) as Bytes32;

describe('checkSignedTag', () => {
  it('accepts when the signed tag is on the allowlist and no hint is provided', () => {
    expect(checkSignedTag(TAG_A, undefined, [TAG_A, TAG_B])).toEqual({ ok: true });
  });

  it('accepts when the transport hint matches the signed tag', () => {
    expect(checkSignedTag(TAG_A, TAG_A, [TAG_A])).toEqual({ ok: true });
  });

  it('rejects when the transport hint disagrees with the signed tag', () => {
    const res = checkSignedTag(TAG_A, TAG_B, [TAG_A, TAG_B]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('content_tag_mismatch');
  });

  it('rejects when the signed tag is not on the allowlist (unknown_tag)', () => {
    const res = checkSignedTag(TAG_C, undefined, [TAG_A, TAG_B]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('unknown_tag');
  });

  it('prefers content_tag_mismatch over unknown_tag when both apply', () => {
    // Signed tag is unknown, AND hint disagrees. The hint-disagreement
    // check should fire first (it's strictly cheaper + more specific).
    const res = checkSignedTag(TAG_C, TAG_B, [TAG_A, TAG_B]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('content_tag_mismatch');
  });

  it('is case-insensitive on the hex strings', () => {
    const upper = ('0x' + 'AA'.repeat(32)) as Bytes32;
    expect(checkSignedTag(TAG_A, upper, [upper])).toEqual({ ok: true });
  });
});
