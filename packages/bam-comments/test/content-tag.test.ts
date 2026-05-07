import { describe, it, expect } from 'vitest';
import { keccak256, toBytes } from 'viem';

import { BAM_COMMENTS_TAG, NAMESPACE } from '../src/content-tag.js';

describe('content-tag', () => {
  it('matches keccak256(utf8(NAMESPACE))', () => {
    const computed = keccak256(toBytes(NAMESPACE));
    expect(computed).toBe(BAM_COMMENTS_TAG);
  });

  it('is pinned to the documented bytes32 literal', () => {
    expect(BAM_COMMENTS_TAG).toBe(
      '0x74d06cf56cb55fea0e37cce28125ed572b2e9f936edcb161ee4138ed1620a512'
    );
  });

  it('namespace is "bam-comments.v1"', () => {
    expect(NAMESPACE).toBe('bam-comments.v1');
  });
});
