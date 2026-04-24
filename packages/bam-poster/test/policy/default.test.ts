import { describe, expect, it } from 'vitest';
import type { Address, Bytes32 } from 'bam-sdk';

import { defaultBatchPolicy, DEFAULT_BLOB_CAPACITY_BYTES } from '../../src/policy/default.js';
import type { DecodedMessage, PoolView } from '../../src/types.js';

const TAG = ('0x' + 'aa'.repeat(32)) as Bytes32;
const SENDER = ('0x' + '11'.repeat(20)) as Address;

function msg(nonce: number, contentsLen: number, ingestedAt = 1_000): DecodedMessage {
  const contents = new Uint8Array(contentsLen);
  contents.fill(0xaa, 0, Math.min(32, contentsLen));
  return {
    sender: SENDER,
    nonce: BigInt(nonce),
    contents,
    contentTag: TAG,
    signature: new Uint8Array(65),
    messageHash: ('0x' + '77'.repeat(32)) as Bytes32,
    ingestedAt,
  };
}

function poolOf(items: DecodedMessage[]): PoolView {
  return { list: (t) => (t === TAG ? items : []) };
}

describe('defaultBatchPolicy', () => {
  it('empty pool returns null (short-circuit)', () => {
    const policy = defaultBatchPolicy();
    const res = policy.select(TAG, poolOf([]), DEFAULT_BLOB_CAPACITY_BYTES, new Date(1_000));
    expect(res).toBeNull();
  });

  it('countTrigger fires when pool size >= threshold', () => {
    const policy = defaultBatchPolicy({ countTrigger: 3, ageTriggerMs: 10_000_000 });
    const res = policy.select(
      TAG,
      poolOf([msg(1, 100), msg(2, 100), msg(3, 100)]),
      DEFAULT_BLOB_CAPACITY_BYTES,
      new Date(1_000)
    );
    expect(res).not.toBeNull();
    expect(res?.msgs.length).toBe(3);
  });

  it('countTrigger below threshold does NOT fire', () => {
    const policy = defaultBatchPolicy({ countTrigger: 5, ageTriggerMs: 10_000_000 });
    const res = policy.select(
      TAG,
      poolOf([msg(1, 100), msg(2, 100)]),
      DEFAULT_BLOB_CAPACITY_BYTES,
      new Date(1_000)
    );
    expect(res).toBeNull();
  });

  it('ageTrigger fires when the oldest message is older than threshold', () => {
    const policy = defaultBatchPolicy({ countTrigger: 100, ageTriggerMs: 5_000 });
    const ingestedAt = 1_000;
    const now = new Date(ingestedAt + 6_000);
    const res = policy.select(TAG, poolOf([msg(1, 100, ingestedAt)]), DEFAULT_BLOB_CAPACITY_BYTES, now);
    expect(res).not.toBeNull();
  });

  it('forceFlush bypasses every threshold', () => {
    const policy = defaultBatchPolicy({
      forceFlush: true,
      countTrigger: 1_000_000,
      ageTriggerMs: 1_000_000,
    });
    const res = policy.select(TAG, poolOf([msg(1, 100)]), DEFAULT_BLOB_CAPACITY_BYTES, new Date(1_000));
    expect(res).not.toBeNull();
    expect(res?.msgs.length).toBe(1);
  });

  it('over-capacity pool is truncated (FIFO greedy walk)', () => {
    // Construct messages whose total estimated size would exceed a very
    // small capacity: picker must stop before the last one.
    const policy = defaultBatchPolicy({ forceFlush: true });
    const all = [msg(1, 200), msg(2, 200), msg(3, 200)];
    const capacity = 500; // well below 3 × (97 overhead + 200 contents)
    const res = policy.select(TAG, poolOf(all), capacity, new Date(1_000));
    expect(res).not.toBeNull();
    // Fewer than 3 messages get picked.
    expect(res!.msgs.length).toBeLessThan(3);
  });
});
