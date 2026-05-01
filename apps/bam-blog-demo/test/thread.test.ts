/**
 * Thread builder behavior:
 *   - groups by postIdHash (one of the 5 known posts)
 *   - drops unknown postIdHash silently
 *   - hides orphan replies (parent missing or under a different post)
 *   - clamps `displayDepth` at 2 even when wire-level chain is deeper
 *   - breaks cycles in `parentMessageHash` chains
 *   - emits stable ordering by (timestamp asc, messageHash asc)
 */

import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';

import { buildThreads, type DecodedMessage } from '../src/widget/thread.js';
import { slugToPostIdHash } from '../src/widget/post-id.js';

const POST_A = slugToPostIdHash('secure-llms');
const POST_B = slugToPostIdHash('balance-of-power');
const UNKNOWN_POST =
  '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex;

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

describe('buildThreads', () => {
  it('returns an empty map for an empty input', () => {
    expect(buildThreads([]).size).toBe(0);
  });

  it('drops messages whose postIdHash is not in KNOWN_POST_IDS', () => {
    const threads = buildThreads([
      comment({ postIdHash: UNKNOWN_POST, timestamp: 1 }),
    ]);
    expect(threads.size).toBe(0);
  });

  it('groups by post; one comment under each of two posts', () => {
    const a = comment({ postIdHash: POST_A, timestamp: 1, content: 'in A' });
    const b = comment({ postIdHash: POST_B, timestamp: 1, content: 'in B' });
    const threads = buildThreads([a, b]);
    expect(threads.get('secure-llms')?.roots[0].message.content).toBe('in A');
    expect(threads.get('balance-of-power')?.roots[0].message.content).toBe('in B');
  });

  it('a single comment becomes one root with displayDepth 0', () => {
    const a = comment({ postIdHash: POST_A, timestamp: 1 });
    const threads = buildThreads([a]);
    const t = threads.get('secure-llms')!;
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
    const t = buildThreads([root, r]).get('secure-llms')!;
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
    const t = buildThreads([root, r1, r2]).get('secure-llms')!;
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
    const t = buildThreads([root, r1, r2, r3]).get('secure-llms')!;
    const deepest = t.roots[0].children[0].children[0].children[0];
    expect(deepest.message.messageHash).toBe(r3.messageHash);
    expect(deepest.displayDepth).toBe(2);
  });

  it('hides a reply whose parent is missing', () => {
    const r = reply({
      postIdHash: POST_A,
      timestamp: 2,
      parentMessageHash: ('0x' + 'ff'.repeat(32)) as Hex,
    });
    const threads = buildThreads([r]);
    expect(threads.size).toBe(0);
  });

  it('hides a reply whose parent is in a different post bucket', () => {
    const inA = comment({ postIdHash: POST_A, timestamp: 1 });
    const replyInB = reply({
      postIdHash: POST_B,
      timestamp: 2,
      parentMessageHash: inA.messageHash,
    });
    const threads = buildThreads([inA, replyInB]);
    expect(threads.has('balance-of-power')).toBe(false);
    expect(threads.get('secure-llms')?.roots).toHaveLength(1);
  });

  it('does not loop or crash on a self-referencing reply', () => {
    const self = fakeHash();
    const r = reply({
      messageHash: self,
      postIdHash: POST_A,
      timestamp: 1,
      parentMessageHash: self,
    });
    expect(() => buildThreads([r])).not.toThrow();
    expect(buildThreads([r]).size).toBe(0);
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
    const threads = buildThreads([ra, rb]);
    expect(threads.size).toBe(0);
  });

  it('sorts roots and children by (timestamp asc, messageHash asc)', () => {
    const c1 = comment({ postIdHash: POST_A, timestamp: 5 });
    const c2 = comment({ postIdHash: POST_A, timestamp: 1 });
    const c3 = comment({ postIdHash: POST_A, timestamp: 5 }); // tie with c1
    const t = buildThreads([c1, c2, c3]).get('secure-llms')!;
    expect(t.roots.map((r) => r.message.timestamp)).toEqual([1, 5, 5]);
    // tie-breaker: messageHash ascending — c1 was generated before c3.
    expect(t.roots[1].message.messageHash.toLowerCase() < t.roots[2].message.messageHash.toLowerCase()).toBe(true);
  });

  it('keeps both pending and confirmed messages in the same tree', () => {
    const root = comment({ postIdHash: POST_A, timestamp: 1, status: 'confirmed' });
    const r = reply({
      postIdHash: POST_A,
      timestamp: 2,
      parentMessageHash: root.messageHash,
      status: 'pending',
    });
    const t = buildThreads([root, r]).get('secure-llms')!;
    expect(t.roots[0].message.status).toBe('confirmed');
    expect(t.roots[0].children[0].message.status).toBe('pending');
  });
});
