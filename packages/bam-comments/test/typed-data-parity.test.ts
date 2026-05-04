import { describe, it, expect } from 'vitest';
import { computeECDSADigest } from 'bam-sdk/browser';

import { buildTypedData, digestTypedData } from '../src/typed-data.js';
import { encodeCommentContents } from '../src/codec.js';
import { BAM_COMMENTS_TAG } from '../src/content-tag.js';

const POST = ('0x' + 'aa'.repeat(32)) as `0x${string}`;

interface Fixture {
  sender: `0x${string}`;
  nonce: bigint;
  chainId: number;
  contents: Uint8Array;
}

const fixtures: Fixture[] = [
  {
    sender: '0x1111111111111111111111111111111111111111',
    nonce: 0n,
    chainId: 11155111,
    contents: encodeCommentContents(BAM_COMMENTS_TAG, {
      kind: 'comment',
      postIdHash: POST,
      timestamp: 1_700_000_000,
      content: 'first',
    }),
  },
  {
    sender: '0x2222222222222222222222222222222222222222',
    nonce: 7n,
    chainId: 11155111,
    contents: encodeCommentContents(BAM_COMMENTS_TAG, {
      kind: 'comment',
      postIdHash: POST,
      timestamp: 1_700_000_001,
      content: 'second',
    }),
  },
  {
    sender: '0x3333333333333333333333333333333333333333',
    nonce: 12345n,
    chainId: 1,
    contents: encodeCommentContents(BAM_COMMENTS_TAG, {
      kind: 'reply',
      postIdHash: POST,
      timestamp: 1_700_000_002,
      parentMessageHash: ('0x' + 'cd'.repeat(32)) as `0x${string}`,
      content: 'reply body',
    }),
  },
  {
    sender: '0x4444444444444444444444444444444444444444',
    nonce: (1n << 60n) - 1n, // large nonce, near uint64 boundary
    chainId: 11155111,
    contents: encodeCommentContents(BAM_COMMENTS_TAG, {
      kind: 'comment',
      postIdHash: POST,
      timestamp: 1_730_000_000,
      content: 'large nonce',
    }),
  },
];

describe('typed-data parity with bam-sdk computeECDSADigest', () => {
  for (const [i, f] of fixtures.entries()) {
    it(`fixture ${i}: digest matches`, () => {
      const td = buildTypedData({
        sender: f.sender,
        nonce: f.nonce,
        contents: f.contents,
        chainId: f.chainId,
      });
      const widgetDigest = digestTypedData(td);
      const sdkDigest = computeECDSADigest(
        { sender: f.sender, nonce: f.nonce, contents: f.contents },
        f.chainId
      );
      expect(widgetDigest).toBe(sdkDigest);
    });
  }
});
