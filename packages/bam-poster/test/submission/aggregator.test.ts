import { describe, expect, it } from 'vitest';
import type { Bytes32, Address } from 'bam-sdk';

import { createAggregator } from '../../src/submission/aggregator.js';
import type {
  BatchPolicy,
  DecodedMessage,
  PoolView,
} from '../../src/types.js';

const TAG_A = ('0x' + 'a1'.repeat(32)) as Bytes32;
const TAG_B = ('0x' + 'b2'.repeat(32)) as Bytes32;
const TAG_C = ('0x' + 'c3'.repeat(32)) as Bytes32;

function msg(seq: number, ingestedAt: number): DecodedMessage {
  const sender = ('0x' + 'aa'.repeat(20)) as Address;
  return {
    sender,
    nonce: BigInt(seq),
    contents: new Uint8Array([seq]),
    signature: new Uint8Array(65),
    messageHash: ('0x' + '00'.repeat(32)) as Bytes32,
    ingestedAt,
    ingestSeq: seq,
  };
}

function makePool(map: Record<string, DecodedMessage[]>): PoolView {
  return {
    list(tag: Bytes32) {
      return map[tag] ?? [];
    },
  };
}

const ALWAYS_FIRE_POLICY: BatchPolicy = {
  select(_tag, pool, _capacityBytes, _now) {
    const list = pool.list(_tag);
    if (list.length === 0) return null;
    return { msgs: [...list] };
  },
  fill(_tag, pool, _capacityBytes) {
    const list = pool.list(_tag);
    return list.length === 0 ? null : { msgs: [...list] };
  },
};

const NEVER_FIRE_POLICY: BatchPolicy = {
  select(_tag, _pool, _capacityBytes, _now) {
    return null;
  },
  // `fill` returns the pool unconditionally — that's the whole point
  // of passenger semantics. A "never fire" policy still passenger-
  // rides if some other tag triggers on the same tick.
  fill(_tag, pool, _capacityBytes) {
    const list = pool.list(_tag);
    return list.length === 0 ? null : { msgs: [...list] };
  },
};

// Encoder stub: produce N bytes per message so payload sizes are predictable.
function fixedEncoder(bytesPerMsg: number) {
  return (msgs: { sender: Address; nonce: bigint; contents: Uint8Array }[]) => {
    return { data: new Uint8Array(msgs.length * bytesPerMsg) };
  };
}

describe('createAggregator', () => {
  it('no-op tick when no tag fires', () => {
    const agg = createAggregator({
      policy: NEVER_FIRE_POLICY,
      tags: [TAG_A, TAG_B],
      maxTagsPerPack: 8,
      blobCapacityBytes: 130_000,
      now: () => new Date(0),
      encodeBatch: fixedEncoder(64),
    });
    const result = agg.tick({
      pool: makePool({ [TAG_A]: [msg(1, 100)] }),
      tags: [TAG_A, TAG_B],
      now: new Date(0),
    });
    expect(result.pack).toBeNull();
    // No pending counted? Actually packingLossSnapshot does observe
    // pending counts even on no-op ticks (we want /health to update).
    const snap = agg.packingLossSnapshot();
    expect(snap.find((s) => s.contentTag === TAG_A)?.pendingCount).toBe(1);
  });

  it('packs included tags, increments streak for excluded tags with non-empty pools', () => {
    // 1000-byte capacity. Three tags, each with one msg encoding to
    // 800 bytes — only one fits. The two oldest-first losers get
    // streak += 1.
    const agg = createAggregator({
      policy: ALWAYS_FIRE_POLICY,
      tags: [TAG_A, TAG_B, TAG_C],
      maxTagsPerPack: 8,
      blobCapacityBytes: 1_000,
      capacityBytes: 1_000,
      capacityFEs: 100,
      now: () => new Date(1_000),
      encodeBatch: fixedEncoder(800),
    });
    const result = agg.tick({
      pool: makePool({
        [TAG_A]: [msg(1, 50)], // oldest
        [TAG_B]: [msg(2, 60)],
        [TAG_C]: [msg(3, 70)],
      }),
      tags: [TAG_A, TAG_B, TAG_C],
      now: new Date(1_000),
    });

    expect(result.pack).not.toBeNull();
    const included = result.pack!.plan.included.map((s) => s.contentTag);
    expect(included).toEqual([TAG_A]);

    const snap = agg.packingLossSnapshot();
    const a = snap.find((s) => s.contentTag === TAG_A)!;
    const b = snap.find((s) => s.contentTag === TAG_B)!;
    const c = snap.find((s) => s.contentTag === TAG_C)!;
    expect(a.packingLossStreak).toBe(0);
    expect(a.lastIncludedAt).toBe(1_000);
    expect(b.packingLossStreak).toBe(1);
    expect(c.packingLossStreak).toBe(1);
  });

  it('streak resets on a tag once it lands', () => {
    const agg = createAggregator({
      policy: ALWAYS_FIRE_POLICY,
      tags: [TAG_A, TAG_B],
      maxTagsPerPack: 8,
      blobCapacityBytes: 1_000,
      capacityBytes: 1_000,
      capacityFEs: 100,
      now: () => new Date(1_000),
      encodeBatch: fixedEncoder(800),
    });

    // Round 1: only TAG_A lands; TAG_B's streak hits 1.
    agg.tick({
      pool: makePool({ [TAG_A]: [msg(1, 50)], [TAG_B]: [msg(2, 60)] }),
      tags: [TAG_A, TAG_B],
      now: new Date(1_000),
    });
    expect(agg.packingLossSnapshot().find((s) => s.contentTag === TAG_B)!.packingLossStreak).toBe(1);

    // Round 2: only TAG_B has data; lands; streak resets to 0.
    agg.tick({
      pool: makePool({ [TAG_A]: [], [TAG_B]: [msg(3, 90)] }),
      tags: [TAG_A, TAG_B],
      now: new Date(2_000),
    });
    const snap = agg.packingLossSnapshot();
    expect(snap.find((s) => s.contentTag === TAG_B)!.packingLossStreak).toBe(0);
  });

  it('respects maxTagsPerPack — extra tags spill to excluded', () => {
    const agg = createAggregator({
      policy: ALWAYS_FIRE_POLICY,
      tags: [TAG_A, TAG_B, TAG_C],
      maxTagsPerPack: 2,
      blobCapacityBytes: 130_000,
      now: () => new Date(0),
      encodeBatch: fixedEncoder(64),
    });
    const result = agg.tick({
      pool: makePool({
        [TAG_A]: [msg(1, 100)],
        [TAG_B]: [msg(2, 200)],
        [TAG_C]: [msg(3, 300)], // newest — capped out by maxTagsPerPack
      }),
      tags: [TAG_A, TAG_B, TAG_C],
      now: new Date(0),
    });
    const included = result.pack!.plan.included.map((s) => s.contentTag);
    expect(included).toEqual([TAG_A, TAG_B]);
    expect(result.pack!.excludedTags).toContain(TAG_C);
  });

  it('passenger fill: a tag whose select did not fire still rides when another tag triggered', () => {
    // `select` fires only for TAG_A; TAG_B has pending but its trigger
    // policy says "not yet". Once TAG_A fires, TAG_B should ride as a
    // passenger via `fill` — capacity sets the fill, triggers set the
    // max latency.
    const SELECT_ONLY_A: BatchPolicy = {
      select(tag, pool, _cap, _now) {
        if (tag !== TAG_A) return null;
        const list = pool.list(tag);
        return list.length === 0 ? null : { msgs: [...list] };
      },
      fill(tag, pool, _cap) {
        const list = pool.list(tag);
        return list.length === 0 ? null : { msgs: [...list] };
      },
    };
    const agg = createAggregator({
      policy: SELECT_ONLY_A,
      tags: [TAG_A, TAG_B],
      maxTagsPerPack: 8,
      blobCapacityBytes: 130_000,
      now: () => new Date(0),
      encodeBatch: fixedEncoder(64),
    });
    const result = agg.tick({
      pool: makePool({
        [TAG_A]: [msg(1, 100)],
        [TAG_B]: [msg(2, 200)],
      }),
      tags: [TAG_A, TAG_B],
      now: new Date(0),
    });
    const included = result.pack!.plan.included.map((s) => s.contentTag);
    expect(included.sort()).toEqual([TAG_A, TAG_B].sort());

    // Streak: TAG_A reset (included), TAG_B unchanged at 0 — passengers
    // do not count as fired-and-excluded.
    const snap = agg.packingLossSnapshot();
    expect(snap.find((s) => s.contentTag === TAG_A)!.packingLossStreak).toBe(0);
    expect(snap.find((s) => s.contentTag === TAG_B)!.packingLossStreak).toBe(0);
  });

  it('passenger fill never bumps the streak on a capacity-loss', () => {
    // TAG_A triggers and fills its 600-byte payload. TAG_B rides as
    // passenger with another 600-byte payload — together they exceed
    // the 1000-byte capacity so TAG_B is dropped by the planner. TAG_B
    // is a passenger, so its streak must NOT increment.
    const SELECT_ONLY_A: BatchPolicy = {
      select(tag, pool, _cap, _now) {
        if (tag !== TAG_A) return null;
        const list = pool.list(tag);
        return list.length === 0 ? null : { msgs: [...list] };
      },
      fill(tag, pool, _cap) {
        const list = pool.list(tag);
        return list.length === 0 ? null : { msgs: [...list] };
      },
    };
    const agg = createAggregator({
      policy: SELECT_ONLY_A,
      tags: [TAG_A, TAG_B],
      maxTagsPerPack: 8,
      blobCapacityBytes: 1_000,
      capacityBytes: 1_000,
      capacityFEs: 100,
      now: () => new Date(1_000),
      encodeBatch: fixedEncoder(600),
    });
    const result = agg.tick({
      pool: makePool({
        [TAG_A]: [msg(1, 100)],
        [TAG_B]: [msg(2, 200)],
      }),
      tags: [TAG_A, TAG_B],
      now: new Date(1_000),
    });
    const included = result.pack!.plan.included.map((s) => s.contentTag);
    expect(included).toEqual([TAG_A]);

    const snap = agg.packingLossSnapshot();
    expect(snap.find((s) => s.contentTag === TAG_A)!.packingLossStreak).toBe(0);
    // The critical assertion: passengers do not contribute to the
    // starvation signal.
    expect(snap.find((s) => s.contentTag === TAG_B)!.packingLossStreak).toBe(0);
  });

  it('multi-tag overflow respects oldest-first when capacity binds', () => {
    // 100-FE cap; each tag's payload is 60 FEs (rounded). Only 1 tag
    // fits (60 + 60 > 100). Oldest wins: TAG_A.
    const sixtyFEs = 60 * 31; // 1860 bytes — produces 60 FEs after FE alignment
    const agg = createAggregator({
      policy: ALWAYS_FIRE_POLICY,
      tags: [TAG_A, TAG_B, TAG_C],
      maxTagsPerPack: 8,
      blobCapacityBytes: 130_000,
      capacityFEs: 100,
      capacityBytes: 130_000,
      now: () => new Date(0),
      encodeBatch: fixedEncoder(sixtyFEs),
    });
    const result = agg.tick({
      pool: makePool({
        [TAG_A]: [msg(1, 100)],
        [TAG_B]: [msg(2, 200)],
        [TAG_C]: [msg(3, 300)],
      }),
      tags: [TAG_A, TAG_B, TAG_C],
      now: new Date(0),
    });
    const included = result.pack!.plan.included.map((s) => s.contentTag);
    expect(included).toEqual([TAG_A]);
  });
});
