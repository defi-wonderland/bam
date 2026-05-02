/**
 * Thread builder behavior, post-refactor (single-tree API):
 *   - returns roots from a flat list of messages already scoped to
 *     one post by the caller
 *   - hides orphan replies (parent missing in the bucket)
 *   - clamps `displayDepth` at 2 even when wire-level chain is deeper
 *   - breaks cycles in `parentMessageHash` chains
 *   - emits stable ordering by (timestamp asc, messageHash asc)
 *
 * Filtering by post id is the controller's responsibility (see
 * `src/widget/index.ts`); the builder treats the input as a single
 * bucket. Tests mix post ids only to confirm the builder doesn't
 * itself drop on a closed-set check.
 */

import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';

import { buildThread, type DecodedMessage } from '../src/widget/thread.js';
import { derivePostIdHash } from '../src/widget/post-id.js';

const POST_A = derivePostIdHash({ siteId: 'bam-blog-demo', postId: 'secure-llms' });

let _hashCounter = 0;
function fakeHash(): Hex {
  _hashCounter += 1;
  return ('0x' + _hashCounter.toString(16).padStart(64, '0')) as Hex;
}

const ALICE = '0x000000000000000000000000000000000000a11ce' as Hex;

function comment(args: {
  postIdHash: Hex;
  timestamp: number;
  content?: string;
  status?: 'pending' | 'confirmed';
  messageHash?: Hex;
}): DecodedMessage {
  return {
    messageHash: args.messageHash ?? fakeHash(),
    postIdHash: args.postIdHash,
    timestamp: args.timestamp,
    content: args.content ?? '…',
    author: ALICE,
    kind: 'comment',
    status: args.status ?? 'confirmed',
  };
}

function reply(args: {
  postIdHash: Hex;
  timestamp: number;
  parentMessageHash: Hex;
  content?: string;
  status?: 'pending' | 'confirmed';
  messageHash?: Hex;
}): DecodedMessage {
  return {
    messageHash: args.messageHash ?? fakeHash(),
    postIdHash: args.postIdHash,
    timestamp: args.timestamp,
    content: args.content ?? '↪',
    author: ALICE,
    kind: 'reply',
    parentMessageHash: args.parentMessageHash,
    status: args.status ?? 'confirmed',
  };
}

describe('buildThread', () => {
  it('returns no roots for an empty input', () => {
    expect(buildThread([]).roots).toEqual([]);
  });

  it('any postIdHash is acceptable — caller filters', () => {
    const arbitrary =
      '0xdeadbeef' + '00'.repeat(28) as Hex;
    const t = buildThread([
      comment({ postIdHash: arbitrary, timestamp: 1, content: 'hi' }),
    ]);
    expect(t.roots).toHaveLength(1);
    expect(t.roots[0].message.content).toBe('hi');
  });

  it('a single comment becomes one root with displayDepth 0', () => {
    const a = comment({ postIdHash: POST_A, timestamp: 1 });
    const t = buildThread([a]);
    expect(t.roots).toHaveLength(1);
    expect(t.roots[0].displayDepth).toBe(0);
    expect(t.roots[0].children).toHaveLength(0);
  });

  it('a reply nests under its comment at displayDepth 1', () => {
    const root = comment({ postIdHash: POST_A, timestamp: 1 });
    const r = reply({
      postIdHash: POST_A,
      timestamp: 2,
      parentMessageHash: root.messageHash,
    });
    const t = buildThread([root, r]);
    expect(t.roots[0].children).toHaveLength(1);
    expect(t.roots[0].children[0].displayDepth).toBe(1);
    expect(t.roots[0].children[0].message.messageHash).toBe(r.messageHash);
  });

  it('depth-2 reply renders with displayDepth 2', () => {
    const root = comment({ postIdHash: POST_A, timestamp: 1 });
    const r1 = reply({
      postIdHash: POST_A,
      timestamp: 2,
      parentMessageHash: root.messageHash,
    });
    const r2 = reply({
      postIdHash: POST_A,
      timestamp: 3,
      parentMessageHash: r1.messageHash,
    });
    const t = buildThread([root, r1, r2]);
    expect(t.roots[0].children[0].children[0].displayDepth).toBe(2);
  });

  it('depth-3 reply still appears, with displayDepth clamped at 2', () => {
    const root = comment({ postIdHash: POST_A, timestamp: 1 });
    const r1 = reply({
      postIdHash: POST_A,
      timestamp: 2,
      parentMessageHash: root.messageHash,
    });
    const r2 = reply({
      postIdHash: POST_A,
      timestamp: 3,
      parentMessageHash: r1.messageHash,
    });
    const r3 = reply({
      postIdHash: POST_A,
      timestamp: 4,
      parentMessageHash: r2.messageHash,
    });
    const t = buildThread([root, r1, r2, r3]);
    const deepest = t.roots[0].children[0].children[0].children[0];
    expect(deepest.message.messageHash).toBe(r3.messageHash);
    expect(deepest.displayDepth).toBe(2);
  });

  it('hides a reply whose parent is missing from the bucket', () => {
    const r = reply({
      postIdHash: POST_A,
      timestamp: 2,
      parentMessageHash: ('0x' + 'ff'.repeat(32)) as Hex,
    });
    const t = buildThread([r]);
    expect(t.roots).toEqual([]);
  });

  it('does not loop or crash on a self-referencing reply', () => {
    const self = fakeHash();
    const r = reply({
      messageHash: self,
      postIdHash: POST_A,
      timestamp: 1,
      parentMessageHash: self,
    });
    expect(() => buildThread([r])).not.toThrow();
    expect(buildThread([r]).roots).toEqual([]);
  });

  it('does not loop or crash on a 2-cycle', () => {
    const a = fakeHash();
    const b = fakeHash();
    const ra = reply({
      messageHash: a,
      postIdHash: POST_A,
      timestamp: 1,
      parentMessageHash: b,
    });
    const rb = reply({
      messageHash: b,
      postIdHash: POST_A,
      timestamp: 2,
      parentMessageHash: a,
    });
    expect(buildThread([ra, rb]).roots).toEqual([]);
  });

  it('sorts roots and children by (timestamp asc, messageHash asc)', () => {
    const c1 = comment({ postIdHash: POST_A, timestamp: 5 });
    const c2 = comment({ postIdHash: POST_A, timestamp: 1 });
    const c3 = comment({ postIdHash: POST_A, timestamp: 5 }); // tie with c1
    const t = buildThread([c1, c2, c3]);
    expect(t.roots.map((r) => r.message.timestamp)).toEqual([1, 5, 5]);
    // tie-breaker: messageHash ascending — c1 was generated before c3.
    expect(
      t.roots[1].message.messageHash.toLowerCase() <
        t.roots[2].message.messageHash.toLowerCase()
    ).toBe(true);
  });

  it('keeps both pending and confirmed messages in the same tree', () => {
    const root = comment({
      postIdHash: POST_A,
      timestamp: 1,
      status: 'confirmed',
    });
    const r = reply({
      postIdHash: POST_A,
      timestamp: 2,
      parentMessageHash: root.messageHash,
      status: 'pending',
    });
    const t = buildThread([root, r]);
    expect(t.roots[0].message.status).toBe('confirmed');
    expect(t.roots[0].children[0].message.status).toBe('pending');
  });
});
