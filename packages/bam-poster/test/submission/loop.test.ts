import { describe, it, expect } from 'vitest';
import type { Address, Bytes32 } from 'bam-sdk';

import { MemoryPosterStore } from '../../src/pool/memory-store.js';
import { defaultBatchPolicy, DEFAULT_BLOB_CAPACITY_BYTES } from '../../src/policy/default.js';
import { SubmissionLoop } from '../../src/submission/loop.js';
import { DEFAULT_BACKOFF } from '../../src/submission/backoff.js';
import type { BuildAndSubmit, SubmitOutcome } from '../../src/submission/types.js';
import type { StoreTxnPendingRow } from '../../src/types.js';

const TAG = ('0x' + 'aa'.repeat(32)) as Bytes32;
const AUTHOR = '0x1111111111111111111111111111111111111111' as Address;

function makePending(i: number): StoreTxnPendingRow {
  return {
    messageId: (`0x${i.toString(16).padStart(64, '0')}`) as Bytes32,
    contentTag: TAG,
    author: AUTHOR,
    nonce: BigInt(i),
    timestamp: 1_700_000_000 + i,
    content: new TextEncoder().encode(`msg-${i}`),
    signature: new Uint8Array(65),
    ingestedAt: 1_700_000_000_000 + i,
    ingestSeq: i,
  };
}

async function seedPool(store: MemoryPosterStore, count: number): Promise<void> {
  await store.withTxn(async (txn) => {
    for (let i = 1; i <= count; i++) await txn.insertPending(makePending(i));
  });
}

function makeLoop(
  store: MemoryPosterStore,
  buildAndSubmit: BuildAndSubmit,
  overrides: { forceFlush?: boolean; now?: () => Date } = {}
): SubmissionLoop {
  return new SubmissionLoop({
    tag: TAG,
    store,
    policy: defaultBatchPolicy({ forceFlush: overrides.forceFlush ?? true }),
    blobCapacityBytes: DEFAULT_BLOB_CAPACITY_BYTES,
    buildAndSubmit,
    backoff: DEFAULT_BACKOFF,
    now: overrides.now ?? (() => new Date(1_700_000_000_000)),
    reorgWindowBlocks: 32,
  });
}

describe('SubmissionLoop — success path', () => {
  it('submits, records the batch, and prunes pending on inclusion', async () => {
    const store = new MemoryPosterStore();
    await seedPool(store, 3);
    const txHash = ('0x' + 'ab'.repeat(32)) as Bytes32;
    const vhash = ('0x' + 'cd'.repeat(32)) as Bytes32;

    let calls = 0;
    const buildAndSubmit: BuildAndSubmit = async (args) => {
      calls++;
      expect(args.contentTag).toBe(TAG);
      expect(args.messages).toHaveLength(3);
      return { kind: 'included', txHash, blobVersionedHash: vhash, blockNumber: 42 };
    };
    const loop = makeLoop(store, buildAndSubmit);

    const outcome = await loop.tick();
    expect(outcome).toBe('success');
    expect(calls).toBe(1);
    expect(loop.healthState()).toBe('ok');

    const remaining = await store.withTxn(async (txn) => txn.listPendingByTag(TAG));
    expect(remaining).toHaveLength(0);
    const submitted = await store.withTxn(async (txn) =>
      txn.listSubmitted({ contentTag: TAG })
    );
    expect(submitted).toHaveLength(1);
    expect(submitted[0].txHash).toBe(txHash);
    expect(submitted[0].blockNumber).toBe(42);
    expect(submitted[0].messageIds).toHaveLength(3);
  });
});

describe('SubmissionLoop — retry + backoff', () => {
  it('records no submitted row on retryable fail and ramps the backoff', async () => {
    const store = new MemoryPosterStore();
    await seedPool(store, 1);
    const buildAndSubmit: BuildAndSubmit = async () =>
      ({ kind: 'retryable', detail: 'rpc down' } as SubmitOutcome);
    const loop = makeLoop(store, buildAndSubmit);

    const outcome = await loop.tick();
    expect(outcome).toBe('retry');
    expect(loop.attempts()).toBe(1);
    expect(loop.nextDelayMs()).toBe(DEFAULT_BACKOFF.baseMs);

    const pending = await store.withTxn(async (txn) => txn.listPendingByTag(TAG));
    expect(pending).toHaveLength(1);
    const submitted = await store.withTxn(async (txn) => txn.listSubmitted({}));
    expect(submitted).toHaveLength(0);

    await loop.tick();
    expect(loop.attempts()).toBe(2);
    expect(loop.nextDelayMs()).toBe(DEFAULT_BACKOFF.baseMs * 2);
  });

  it('flips health to degraded after N consecutive retryable failures', async () => {
    const store = new MemoryPosterStore();
    await seedPool(store, 1);
    const buildAndSubmit: BuildAndSubmit = async () =>
      ({ kind: 'retryable', detail: 'gas too high' } as SubmitOutcome);
    const loop = makeLoop(store, buildAndSubmit);

    for (let i = 0; i < DEFAULT_BACKOFF.degradedAfterAttempts; i++) {
      await loop.tick();
    }
    expect(loop.healthState()).toBe('degraded');
  });

  it('retryable-then-success clears backoff state', async () => {
    const store = new MemoryPosterStore();
    await seedPool(store, 2);
    let call = 0;
    const buildAndSubmit: BuildAndSubmit = async () => {
      call++;
      if (call === 1) return { kind: 'retryable', detail: 'flake' };
      return {
        kind: 'included',
        txHash: ('0x' + '11'.repeat(32)) as Bytes32,
        blobVersionedHash: ('0x' + '22'.repeat(32)) as Bytes32,
        blockNumber: 100,
      };
    };
    const loop = makeLoop(store, buildAndSubmit);
    expect(await loop.tick()).toBe('retry');
    expect(loop.attempts()).toBe(1);
    expect(await loop.tick()).toBe('success');
    expect(loop.attempts()).toBe(0);
    expect(loop.healthState()).toBe('ok');
  });
});

describe('SubmissionLoop — permanent failure', () => {
  it('flips health to unhealthy and stops retrying', async () => {
    const store = new MemoryPosterStore();
    await seedPool(store, 1);
    let calls = 0;
    const buildAndSubmit: BuildAndSubmit = async () => {
      calls++;
      return { kind: 'permanent', detail: 'tx reverted' };
    };
    const loop = makeLoop(store, buildAndSubmit);
    const first = await loop.tick();
    expect(first).toBe('permanent');
    expect(loop.healthState()).toBe('unhealthy');
    const second = await loop.tick();
    expect(second).toBe('permanent');
    expect(calls).toBe(1); // never retried after permanent
  });
});

describe('SubmissionLoop — empty selection', () => {
  it('short-circuits without invoking buildAndSubmit when pool is empty', async () => {
    const store = new MemoryPosterStore();
    let calls = 0;
    const buildAndSubmit: BuildAndSubmit = async () => {
      calls++;
      return {
        kind: 'included',
        txHash: ('0x' + '99'.repeat(32)) as Bytes32,
        blobVersionedHash: ('0x' + '99'.repeat(32)) as Bytes32,
        blockNumber: 1,
      };
    };
    const loop = makeLoop(store, buildAndSubmit);
    const outcome = await loop.tick();
    expect(outcome).toBe('idle');
    expect(calls).toBe(0);
  });

  it('short-circuits when the policy returns null (no trigger met)', async () => {
    const store = new MemoryPosterStore();
    await seedPool(store, 1);
    let calls = 0;
    const buildAndSubmit: BuildAndSubmit = async () => {
      calls++;
      return {
        kind: 'included',
        txHash: ('0x' + '99'.repeat(32)) as Bytes32,
        blobVersionedHash: ('0x' + '99'.repeat(32)) as Bytes32,
        blockNumber: 1,
      };
    };
    // forceFlush: false + high thresholds = policy returns null
    const loop = new SubmissionLoop({
      tag: TAG,
      store,
      policy: defaultBatchPolicy({
        forceFlush: false,
        sizeTriggerRatio: 0.999,
        ageTriggerMs: 10 ** 9,
        countTrigger: 10 ** 9,
      }),
      blobCapacityBytes: DEFAULT_BLOB_CAPACITY_BYTES,
      buildAndSubmit,
      backoff: DEFAULT_BACKOFF,
      now: () => new Date(1_700_000_000_000),
      reorgWindowBlocks: 32,
    });
    const outcome = await loop.tick();
    expect(outcome).toBe('idle');
    expect(calls).toBe(0);
  });
});
