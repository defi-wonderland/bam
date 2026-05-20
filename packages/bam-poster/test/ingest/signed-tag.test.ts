import { describe, expect, it } from 'vitest';
import type { Bytes32 } from 'bam-sdk';

import { checkContentTag } from '../../src/ingest/signed-tag.js';

const TAG_A = ('0x' + 'aa'.repeat(32)) as Bytes32;
const TAG_B = ('0x' + 'bb'.repeat(32)) as Bytes32;

describe('checkContentTag', () => {
  it('envelope tag is on allowlist → ok', () => {
    const res = checkContentTag(TAG_A, [TAG_A, TAG_B]);
    expect(res.ok).toBe(true);
  });

  it('envelope tag NOT on allowlist → unknown_tag', () => {
    const res = checkContentTag(TAG_A, [TAG_B]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('unknown_tag');
  });

  it('empty allowlist rejects every envelope tag', () => {
    const res = checkContentTag(TAG_A, []);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('unknown_tag');
  });

  it('case-insensitive match (envelope tag 0xAA… vs allowlist 0xaa…)', () => {
    const upper = ('0x' + 'AA'.repeat(32)) as Bytes32;
    const res = checkContentTag(upper, [TAG_A]);
    expect(res.ok).toBe(true);
  });
});
