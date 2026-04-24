import { describe, expect, it } from 'vitest';
import type { Bytes32 } from 'bam-sdk';

import { checkContentTag } from '../../src/ingest/signed-tag.js';

const TAG_A = ('0x' + 'aa'.repeat(32)) as Bytes32;
const TAG_B = ('0x' + 'bb'.repeat(32)) as Bytes32;

function contentsWith(tag: Bytes32, extra = 0): Uint8Array {
  const hex = tag.slice(2);
  const tagBytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < tagBytes.length; i++) {
    tagBytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  const out = new Uint8Array(32 + extra);
  out.set(tagBytes, 0);
  for (let i = 0; i < extra; i++) out[32 + i] = i & 0xff;
  return out;
}

describe('checkContentTag', () => {
  it('envelope tag == contents[0..32] && allowlisted → ok', () => {
    const res = checkContentTag(TAG_A, contentsWith(TAG_A, 10), [TAG_A, TAG_B]);
    expect(res.ok).toBe(true);
  });

  it('envelope tag differs from contents[0..32] → content_tag_mismatch', () => {
    const res = checkContentTag(TAG_B, contentsWith(TAG_A, 10), [TAG_A, TAG_B]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('content_tag_mismatch');
  });

  it('signed tag NOT on allowlist → unknown_tag', () => {
    const res = checkContentTag(TAG_A, contentsWith(TAG_A, 5), [TAG_B]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('unknown_tag');
  });

  it('contents shorter than 32 bytes → malformed (defensive guard)', () => {
    const res = checkContentTag(TAG_A, new Uint8Array(31), [TAG_A]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('malformed');
  });

  it('empty allowlist rejects every signed tag', () => {
    const res = checkContentTag(TAG_A, contentsWith(TAG_A, 5), []);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('unknown_tag');
  });

  it('case-insensitive match (signed tag 0xAA… vs allowlist 0xaa…)', () => {
    const upper = ('0x' + 'AA'.repeat(32)) as Bytes32;
    const res = checkContentTag(upper, contentsWith(TAG_A, 0), [TAG_A]);
    expect(res.ok).toBe(true);
  });
});
