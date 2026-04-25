import { describe, expect, it } from 'vitest';
import type { Address, Bytes32 } from 'bam-sdk';

import { SubmissionLoop } from '../../src/submission/loop.js';
import { DEFAULT_BACKOFF } from '../../src/submission/backoff.js';
import { MemoryBamStore } from 'bam-store';
import type { BuildAndSubmit, SubmitOutcome } from '../../src/submission/types.js';
import type { BatchPolicy, DecodedMessage, PoolView } from '../../src/types.js';

const TAG = ('0x' + 'aa'.repeat(32)) as Bytes32;
const SENDER = ('0x' + '11'.repeat(20)) as Address;

function decoded(nonce: number, ingestSeq = nonce): DecodedMessage {
  const contents = new Uint8Array(40);
  contents.fill(0xaa, 0, 32);
  return {
    sender: SENDER,
    nonce: BigInt(nonce),
    contents,
    contentTag: TAG,
    signature: new Uint8Array(65),
    messageHash: (('0x' + nonce.toString(16).padStart(64, '0')) as Bytes32),
    ingestedAt: 1_000 + ingestSeq,
  };
}

function mkPolicy(select: (pool: PoolView) => DecodedMessage[] | null): BatchPolicy {
  return {
    select: (_tag, pool) => {
      const msgs = select(pool);
      return msgs === null ? null : { msgs };
    },
  };
}

interface Harness {
  store: MemoryBamStore;
  loop: SubmissionLoop;
  outcomes: SubmitOutcome[];
  build: BuildAndSubmit;
}

function mkHarness(opts: {
  outcome: SubmitOutcome | 'sequence';
  sequence?: SubmitOutcome[];
  policyPicks?: number;
}): Harness {
  const store = new MemoryBamStore();
  const picks = opts.policyPicks ?? 2;
  const policy = mkPolicy((pool) => {
    const msgs = pool.list(TAG);
    if (msgs.length === 0) return null;
    return msgs.slice(0, picks);
  });
  const calls: SubmitOutcome[] = [];
  let idx = 0;
  const build: BuildAndSubmit = async () => {
    const out =
      opts.outcome === 'sequence' ? opts.sequence![idx++] : opts.outcome;
    calls.push(out);
    return out;
  };
  const loop = new SubmissionLoop({
    tag: TAG,
    store,
    policy,
    blobCapacityBytes: 100_000,
    buildAndSubmit: build,
    backoff: DEFAULT_BACKOFF,
    now: () => new Date(5_000),
    reorgWindowBlocks: 32,
  });
  return { store, loop, outcomes: calls, build };
}

async function seedPending(store: MemoryBamStore, count: number): Promise<void> {
  await store.withTxn(async (txn) => {
    for (let i = 1; i <= count; i++) {
      const contents = new Uint8Array(40);
      contents.fill(0xaa, 0, 32);
      txn.insertPending({
        contentTag: TAG,
        sender: SENDER,
        nonce: BigInt(i),
        contents,
        signature: new Uint8Array(65),
        messageHash: (('0x' + i.toString(16).padStart(64, '0')) as Bytes32),
        ingestedAt: 1_000 + i,
        ingestSeq: i,
      });
    }
  });
}

describe('SubmissionLoop', () => {
  it('empty pool → idle, no submission', async () => {
    const h = mkHarness({
      outcome: { kind: 'included', txHash: '0x01' as Bytes32, blockNumber: 1, txIndex: 0, blobVersionedHash: '0x02' as Bytes32 },
    });
    const res = await h.loop.tick();
    expect(res).toBe('idle');
    expect(h.outcomes.length).toBe(0);
  });

  it('successful submit records submitted batch, prunes pending, resets backoff', async () => {
    const h = mkHarness({
      outcome: {
        kind: 'included',
        txHash: ('0x' + 'aa'.repeat(32)) as Bytes32,
        blockNumber: 100,
        txIndex: 0,
        blobVersionedHash: ('0x' + 'bb'.repeat(32)) as Bytes32,
      },
      policyPicks: 2,
    });
    await seedPending(h.store, 3);
    const res = await h.loop.tick();
    expect(res).toBe('success');
    const remaining = await h.store.withTxn((txn) =>
      Promise.resolve(txn.listPendingByTag(TAG))
    );
    expect(remaining.map((r) => Number(r.nonce))).toEqual([3]);
    const batches = await h.store.withTxn((txn) =>
      Promise.resolve(txn.listBatches({ contentTag: TAG }))
    );
    expect(batches.length).toBe(1);
    expect(batches[0].batchContentHash).toBe('0x' + 'bb'.repeat(32));
    const attached = await h.store.withTxn((txn) =>
      Promise.resolve(txn.listMessages({ batchRef: batches[0].txHash }))
    );
    expect(attached.length).toBe(2);
    // Each message gets a batch-scoped messageId.
    expect(attached[0].messageId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(h.loop.attempts()).toBe(0);
    expect(h.loop.healthState()).toBe('ok');
  });

  it('retryable failure increments backoff without pruning pending', async () => {
    const h = mkHarness({
      outcome: { kind: 'retryable', detail: 'rpc_down' },
      policyPicks: 1,
    });
    await seedPending(h.store, 1);
    const res = await h.loop.tick();
    expect(res).toBe('retry');
    const remaining = await h.store.withTxn((txn) =>
      Promise.resolve(txn.listPendingByTag(TAG))
    );
    expect(remaining.length).toBe(1);
    expect(h.loop.attempts()).toBe(1);
    expect(h.loop.nextDelayMs()).toBeGreaterThan(0);
  });

  it('permanent failure stops the worker (subsequent ticks return "permanent")', async () => {
    const h = mkHarness({
      outcome: { kind: 'permanent', detail: 'abi_mismatch' },
      policyPicks: 1,
    });
    await seedPending(h.store, 1);
    await h.loop.tick();
    expect(h.loop.healthState()).toBe('unhealthy');
    const follow = await h.loop.tick();
    expect(follow).toBe('permanent');
  });

  it('degraded health after N consecutive retryable failures', async () => {
    const h = mkHarness({
      outcome: { kind: 'retryable', detail: 'rpc_down' },
      policyPicks: 1,
    });
    await seedPending(h.store, 1);
    for (let i = 0; i < DEFAULT_BACKOFF.degradedAfterAttempts; i++) {
      await h.loop.tick();
    }
    expect(h.loop.healthState()).toBe('degraded');
  });

  it('messageSnapshot covers every picked message — never drops one whose pending row is gone', async () => {
    // Regression: the snapshot used to be built from getPendingByKey(),
    // which filters to status='pending'. If a row was transitioned out
    // of pending by another writer in a shared-DB scenario, it'd be
    // silently missing from the snapshot, and listSubmittedBatches
    // would then surface a confirmed batch with fewer messages than
    // were actually submitted. Build from `picked` instead.
    const h = mkHarness({
      outcome: {
        kind: 'included',
        txHash: ('0x' + 'aa'.repeat(32)) as Bytes32,
        blockNumber: 100,
        txIndex: 0,
        blobVersionedHash: ('0x' + 'bb'.repeat(32)) as Bytes32,
      },
      policyPicks: 2,
    });
    await seedPending(h.store, 2);
    // Simulate a concurrent writer transitioning one of the picked rows
    // out of `pending` BEFORE the loop's withTxn runs. We do this via a
    // build-and-submit hook that fires after the policy has selected
    // both messages but before the loop's confirmation withTxn opens.
    const originalBuild = h.build;
    h.loop = new SubmissionLoop({
      tag: TAG,
      store: h.store,
      policy: mkPolicy((pool) => {
        const msgs = pool.list(TAG);
        return msgs.length === 0 ? null : msgs.slice(0, 2);
      }),
      blobCapacityBytes: 100_000,
      buildAndSubmit: async (args) => {
        // Flip nonce=1 to confirmed under a side-batch so it is no
        // longer 'pending' when the loop's confirmation block runs.
        await h.store.withTxn(async (txn) => {
          await txn.upsertBatch({
            txHash: ('0x' + 'cc'.repeat(32)) as Bytes32,
            chainId: 31337,
            contentTag: TAG,
            blobVersionedHash: ('0x' + 'dd'.repeat(32)) as Bytes32,
            batchContentHash: ('0x' + 'ee'.repeat(32)) as Bytes32,
            blockNumber: 50,
            txIndex: 0,
            status: 'confirmed',
            replacedByTxHash: null,
            submittedAt: 1_500,
            invalidatedAt: null,
            messageSnapshot: [],
          });
          await txn.upsertObserved({
            messageId: ('0x' + 'ff'.repeat(32)) as Bytes32,
            author: SENDER,
            nonce: 1n,
            contentTag: TAG,
            contents: new Uint8Array(40),
            signature: new Uint8Array(65),
            messageHash: ('0x' + (1).toString(16).padStart(64, '0')) as Bytes32,
            status: 'confirmed',
            batchRef: ('0x' + 'cc'.repeat(32)) as Bytes32,
            ingestedAt: 1_001,
            ingestSeq: 1,
            blockNumber: 50,
            txIndex: 0,
            messageIndexWithinBatch: 0,
          });
        });
        return originalBuild(args);
      },
      backoff: DEFAULT_BACKOFF,
      now: () => new Date(5_000),
      reorgWindowBlocks: 32,
    });
    const res = await h.loop.tick();
    expect(res).toBe('success');
    const batches = await h.store.withTxn((txn) =>
      txn.listBatches({ contentTag: TAG, status: 'confirmed' })
    );
    const ours = batches.find((b) => b.txHash === '0x' + 'aa'.repeat(32));
    expect(ours).toBeDefined();
    // Both picked messages must appear in the snapshot — even though
    // nonce=1's pending row was already transitioned out before the
    // confirmation block ran.
    expect(ours!.messageSnapshot.length).toBe(2);
    expect(ours!.messageSnapshot.map((e) => Number(e.nonce)).sort()).toEqual([1, 2]);
  });
});
