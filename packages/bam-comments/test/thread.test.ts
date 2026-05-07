import { describe, it, expect } from 'vitest';

import { buildThread, type DecodedMessage } from '../src/thread.js';

const POST = ('0x' + 'aa'.repeat(32)) as `0x${string}`;

function msg(
  hashByte: number,
  parentByte: number | null,
  timestamp = 1_700_000_000,
  pending = false
): DecodedMessage {
  const hex = (b: number) =>
    ('0x' + b.toString(16).padStart(2, '0').repeat(32)) as `0x${string}`;
  const m: DecodedMessage = {
    messageHash: hex(hashByte),
    sender: '0x0000000000000000000000000000000000000001' as `0x${string}`,
    senderLower: '0x0000000000000000000000000000000000000001',
    postIdHash: POST,
    timestamp,
    content: `c${hashByte}`,
    pending,
  };
  if (parentByte !== null) m.parentMessageHash = hex(parentByte);
  return m;
}

describe('thread builder', () => {
  it('single comment → one root, displayDepth 0', () => {
    const { roots } = buildThread([msg(0x01, null)]);
    expect(roots).toHaveLength(1);
    expect(roots[0].displayDepth).toBe(0);
    expect(roots[0].depth).toBe(0);
    expect(roots[0].children).toHaveLength(0);
  });

  it('reply → displayDepth 1', () => {
    const { roots } = buildThread([msg(0x01, null), msg(0x02, 0x01)]);
    expect(roots).toHaveLength(1);
    expect(roots[0].children).toHaveLength(1);
    expect(roots[0].children[0].displayDepth).toBe(1);
  });

  it('reply-of-reply → displayDepth 2', () => {
    const { roots } = buildThread([
      msg(0x01, null),
      msg(0x02, 0x01),
      msg(0x03, 0x02),
    ]);
    expect(roots[0].children[0].children[0].displayDepth).toBe(2);
    expect(roots[0].children[0].children[0].depth).toBe(2);
  });

  it('depth-3 input clamps displayDepth at 2 but preserves wire depth', () => {
    const { roots } = buildThread([
      msg(0x01, null),
      msg(0x02, 0x01),
      msg(0x03, 0x02),
      msg(0x04, 0x03),
    ]);
    const deepest = roots[0].children[0].children[0].children[0];
    expect(deepest.depth).toBe(3);
    expect(deepest.displayDepth).toBe(2);
  });

  it('hides orphan replies (parent missing in bucket)', () => {
    const orphan = msg(0x05, 0xff); // parent never appears
    const root = msg(0x01, null);
    const { roots } = buildThread([root, orphan]);
    expect(roots).toHaveLength(1);
    expect(roots[0].messageHash).toBe(root.messageHash);
    // Walk children: orphan should not appear anywhere.
    const seen = new Set<string>();
    const walk = (n: { messageHash: string; children: typeof roots }) => {
      seen.add(n.messageHash);
      n.children.forEach((c) => walk(c));
    };
    roots.forEach(walk);
    expect(seen.has(orphan.messageHash)).toBe(false);
  });

  it('breaks self-cycles without looping', () => {
    const selfCycle = msg(0x01, 0x01);
    const root = msg(0x02, null);
    const { roots } = buildThread([selfCycle, root]);
    // The self-cycle node is dropped; the unrelated root survives.
    expect(roots).toHaveLength(1);
    expect(roots[0].messageHash).toBe(root.messageHash);
  });

  it('breaks 2-cycles without looping', () => {
    const a = msg(0x01, 0x02);
    const b = msg(0x02, 0x01);
    const { roots } = buildThread([a, b]);
    expect(roots).toHaveLength(0);
  });

  it('orders siblings by timestamp asc, then messageHash asc', () => {
    const root = msg(0x01, null);
    const childA = msg(0x10, 0x01, 100);
    const childB = msg(0x20, 0x01, 100); // tie on ts → hash tiebreak
    const childC = msg(0x05, 0x01, 50); // earliest ts
    const { roots } = buildThread([childB, childA, root, childC]);
    const order = roots[0].children.map((c) => c.messageHash);
    expect(order).toEqual([childC.messageHash, childA.messageHash, childB.messageHash]);
  });

  it('orders roots stably', () => {
    const r1 = msg(0xaa, null, 200);
    const r2 = msg(0xbb, null, 100);
    const { roots } = buildThread([r1, r2]);
    expect(roots.map((r) => r.messageHash)).toEqual([r2.messageHash, r1.messageHash]);
  });
});
