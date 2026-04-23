import { describe, it, expect } from 'vitest';
import type { Address, Bytes32 } from 'bam-sdk';

import { DEFAULT_BLOB_CAPACITY_BYTES, defaultBatchPolicy } from '../../src/policy/default.js';
import type { DecodedMessage, PoolView } from '../../src/types.js';

const TAG = ('0x' + 'aa'.repeat(32)) as Bytes32;
const AUTHOR = '0x1111111111111111111111111111111111111111' as Address;

function msg(overrides: Partial<DecodedMessage> = {}): DecodedMessage {
  return {
    author: AUTHOR,
    timestamp: 1_700_000_000,
    nonce: 1n,
    content: 'hello world',
    contentTag: TAG,
    signature: new Uint8Array(65),
    messageId: ('0x' + '11'.repeat(32)) as Bytes32,
    raw: new Uint8Array(10),
    ...overrides,
  };
}

function fixedPool(messages: DecodedMessage[]): PoolView {
  return { list: () => messages };
}

describe('defaultBatchPolicy — triggers', () => {
  it('returns null on an empty pool (short-circuits submission)', () => {
    const policy = defaultBatchPolicy();
    const res = policy.select(TAG, fixedPool([]), DEFAULT_BLOB_CAPACITY_BYTES, new Date());
    expect(res).toBeNull();
  });

  it('does not fire when below all triggers', () => {
    const policy = defaultBatchPolicy({
      sizeTriggerRatio: 0.9,
      ageTriggerMs: 60_000,
      countTrigger: 100,
    });
    const ts = 1_700_000_000;
    const now = new Date(ts * 1000 + 1000);
    const msgs = [msg({ timestamp: ts, content: 'x', nonce: 1n })];
    const res = policy.select(TAG, fixedPool(msgs), DEFAULT_BLOB_CAPACITY_BYTES, now);
    expect(res).toBeNull();
  });

  it('fires on size trigger', () => {
    const policy = defaultBatchPolicy({
      sizeTriggerRatio: 0.0001, // threshold ≈ 13 bytes — any selected batch beats it
      ageTriggerMs: 10 ** 9,
      countTrigger: 10 ** 9,
    });
    const msgs = [msg({ content: 'small' })];
    const res = policy.select(TAG, fixedPool(msgs), DEFAULT_BLOB_CAPACITY_BYTES, new Date());
    expect(res).not.toBeNull();
  });

  it('fires on age trigger', () => {
    const policy = defaultBatchPolicy({
      sizeTriggerRatio: 0.999,
      ageTriggerMs: 1000,
      countTrigger: 10 ** 9,
    });
    const ingestedAt = 1_700_000_000_000;
    const now = new Date(ingestedAt + 5000);
    const res = policy.select(
      TAG,
      fixedPool([msg({ ingestedAt })]),
      DEFAULT_BLOB_CAPACITY_BYTES,
      now
    );
    expect(res).not.toBeNull();
  });

  it('age trigger does NOT fire off the author-signed timestamp (FU-review-cubic)', () => {
    const policy = defaultBatchPolicy({
      sizeTriggerRatio: 0.999,
      ageTriggerMs: 1000,
      countTrigger: 10 ** 9,
    });
    // Author claims a timestamp far in the past, but the message was
    // ingested now — age trigger should NOT fire.
    const now = new Date(1_700_000_000_000);
    const ingestedAt = now.getTime();
    const res = policy.select(
      TAG,
      fixedPool([msg({ timestamp: 1, ingestedAt })]),
      DEFAULT_BLOB_CAPACITY_BYTES,
      now
    );
    expect(res).toBeNull();
  });

  it('age trigger does NOT fire when ingestedAt is absent (malformed pool view)', () => {
    const policy = defaultBatchPolicy({
      sizeTriggerRatio: 0.999,
      ageTriggerMs: 1000,
      countTrigger: 10 ** 9,
    });
    const ts = 1_700_000_000;
    const now = new Date(ts * 1000 + 10_000);
    // No ingestedAt — the submission loop always populates it from
    // pool rows, but if it's missing, the age trigger must not fall
    // back to the author-signed `timestamp` (which is attacker-set).
    const res = policy.select(
      TAG,
      fixedPool([msg({ timestamp: ts })]),
      DEFAULT_BLOB_CAPACITY_BYTES,
      now
    );
    expect(res).toBeNull();
  });

  it('fires on count trigger', () => {
    const policy = defaultBatchPolicy({
      sizeTriggerRatio: 0.999,
      ageTriggerMs: 10 ** 9,
      countTrigger: 3,
    });
    const msgs = [msg({ nonce: 1n }), msg({ nonce: 2n }), msg({ nonce: 3n })];
    const res = policy.select(TAG, fixedPool(msgs), DEFAULT_BLOB_CAPACITY_BYTES, new Date());
    expect(res).not.toBeNull();
    if (res) expect(res.msgs).toHaveLength(3);
  });

  it('count trigger evaluates the pool, not the blob-capped selection (cubic review)', () => {
    // Pool of 5 large messages; blob capacity only fits 2 per tick.
    // Pre-fix the count-trigger read `picked.length` (2) and returned
    // null when compared against countTrigger=3 — flushing never
    // fired on count until size or age kicked in. Post-fix we
    // compare against `pending.length` (5) and fire immediately.
    const policy = defaultBatchPolicy({
      sizeTriggerRatio: 0.999,
      ageTriggerMs: 10 ** 9,
      countTrigger: 3,
    });
    // Moderate content sizes so the blob-capacity cap bites after a
    // few messages — estimateBatchSize compresses aggressively, so
    // use a tight capacity here instead of huge payloads.
    const msgs = Array.from({ length: 10 }, (_, i) => {
      const payload = (i.toString(16) + Math.random().toString(36).slice(2)).repeat(200);
      return msg({ nonce: BigInt(i + 1), content: payload });
    });
    const res = policy.select(TAG, fixedPool(msgs), 2000, new Date());
    expect(res).not.toBeNull();
    // The picked subset is still size-capped; we fire with whatever
    // fits, and the submission loop drains the remainder next tick.
    expect(res!.msgs.length).toBeGreaterThan(0);
    expect(res!.msgs.length).toBeLessThan(10);
    expect(res!.msgs[0].nonce).toBe(1n);
  });

  it('forceFlush trumps every trigger threshold', () => {
    const policy = defaultBatchPolicy({ forceFlush: true });
    const msgs = [msg()];
    const res = policy.select(TAG, fixedPool(msgs), DEFAULT_BLOB_CAPACITY_BYTES, new Date());
    expect(res).not.toBeNull();
  });
});

describe('defaultBatchPolicy — capacity-aware FIFO', () => {
  it('walks FIFO and carries over excess', () => {
    const policy = defaultBatchPolicy({ forceFlush: true });
    // Synthesize messages with large content; the capacity will cap us.
    const big = 'x'.repeat(5000);
    const msgs = Array.from({ length: 50 }, (_, i) =>
      msg({ nonce: BigInt(i + 1), content: big })
    );
    const res = policy.select(TAG, fixedPool(msgs), 20 * 1024, new Date());
    expect(res).not.toBeNull();
    expect(res!.msgs.length).toBeGreaterThan(0);
    expect(res!.msgs.length).toBeLessThan(50);
    // FIFO: first picked msg is msg 1
    expect(res!.msgs[0].nonce).toBe(1n);
    // Excess stays pending (unpicked tail preserved in order)
  });

  it('returns null if not a single message fits in capacity', () => {
    const policy = defaultBatchPolicy({ forceFlush: true });
    const huge = 'x'.repeat(200_000);
    const msgs = [msg({ content: huge })];
    const res = policy.select(TAG, fixedPool(msgs), 1024, new Date());
    expect(res).toBeNull();
  });
});
