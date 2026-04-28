import { describe, expect, it } from 'vitest';
import type { Address, Bytes32 } from 'bam-sdk';

import {
  ReorgWatcher,
  clampReorgWindow,
  MIN_REORG_WINDOW,
  MAX_REORG_WINDOW,
  DEFAULT_REORG_WINDOW,
  type BlockSource,
} from '../../src/submission/reorg-watcher.js';
import { createMemoryStore } from 'bam-store';
import type { BamStore } from 'bam-store';

interface Snapshot {
  sender: Address;
  nonce: bigint;
  contents: Uint8Array;
  signature: Uint8Array;
  messageHash: Bytes32;
  messageId: Bytes32;
  originalIngestSeq: number;
}

/**
 * Test shim: seed a confirmed batch via the unified-schema ops
 * (upsertBatch + upsertObserved for each message). Replaces the old
 * insertSubmitted path these tests used before T008/T009.
 */
async function seedConfirmedBatch(
  store: BamStore,
  args: {
    txHash: Bytes32;
    contentTag: Bytes32;
    blobVersionedHash: Bytes32;
    batchContentHash: Bytes32;
    blockNumber: number;
    submittedAt: number;
    messages: Snapshot[];
  }
): Promise<void> {
  await store.withTxn(async (txn) => {
    await txn.upsertBatch({
      txHash: args.txHash,
      chainId: 31337,
      contentTag: args.contentTag,
      blobVersionedHash: args.blobVersionedHash,
      batchContentHash: args.batchContentHash,
      blockNumber: args.blockNumber,
      txIndex: null,
      status: 'confirmed',
      replacedByTxHash: null,
      submittedAt: args.submittedAt,
      invalidatedAt: null,
      messageSnapshot: args.messages.map((m, i) => ({
        author: m.sender,
        nonce: m.nonce,
        messageId: m.messageId,
        messageHash: m.messageHash,
        messageIndexWithinBatch: i,
      })),
    });
    for (let i = 0; i < args.messages.length; i++) {
      const m = args.messages[i];
      await txn.upsertObserved({
        messageId: m.messageId,
        author: m.sender,
        nonce: m.nonce,
        contentTag: args.contentTag,
        contents: m.contents,
        signature: m.signature,
        messageHash: m.messageHash,
        status: 'confirmed',
        batchRef: args.txHash,
        ingestedAt: null,
        ingestSeq: m.originalIngestSeq,
        blockNumber: args.blockNumber,
        txIndex: null,
        messageIndexWithinBatch: i,
      });
    }
  });
}

const TAG = ('0x' + 'aa'.repeat(32)) as Bytes32;
const SENDER = ('0x' + '11'.repeat(20)) as Address;
const TX_A = ('0x' + '01'.repeat(32)) as Bytes32;
const BVH_A = ('0x' + '02'.repeat(32)) as Bytes32;
const BCH_A = ('0x' + '03'.repeat(32)) as Bytes32;

function snapshot(nonce: number, seq: number): Snapshot {
  const contents = new Uint8Array(40);
  contents.fill(0xaa, 0, 32);
  return {
    sender: SENDER,
    nonce: BigInt(nonce),
    contents,
    signature: new Uint8Array(65),
    messageHash: (('0x' + nonce.toString(16).padStart(64, '0')) as Bytes32),
    messageId: (('0x' + (nonce + 100).toString(16).padStart(64, '0')) as Bytes32),
    originalIngestSeq: seq,
  };
}

function mkBlockSource(opts: {
  head: bigint;
  reorgedTxs: Bytes32[];
  headForTx?: Map<Bytes32, number | null>;
}): BlockSource {
  return {
    async getBlockNumber() {
      return opts.head;
    },
    async getTransactionBlock(txHash) {
      if (opts.headForTx?.has(txHash)) return opts.headForTx.get(txHash) ?? null;
      if (opts.reorgedTxs.includes(txHash)) return null;
      return 100; // default: still canonical
    },
  };
}

describe('clampReorgWindow', () => {
  it('clamps below MIN', () => expect(clampReorgWindow(1)).toBe(MIN_REORG_WINDOW));
  it('clamps above MAX', () => expect(clampReorgWindow(9_999)).toBe(MAX_REORG_WINDOW));
  it('passes DEFAULT through', () =>
    expect(clampReorgWindow(DEFAULT_REORG_WINDOW)).toBe(DEFAULT_REORG_WINDOW));
  it('NaN → DEFAULT', () => expect(clampReorgWindow(Number.NaN)).toBe(DEFAULT_REORG_WINDOW));
});

describe('ReorgWatcher', () => {
  it('in-window reorg marks included row as reorged with invalidatedAt set', async () => {
    const store = await createMemoryStore();
    const submittedAt = 1_000;
    await seedConfirmedBatch(store, {
        txHash: TX_A,
        contentTag: TAG,
        blobVersionedHash: BVH_A,
        batchContentHash: BCH_A,
        blockNumber: 100,
        submittedAt,
        messages: [snapshot(1, 1), snapshot(2, 2)],
      });
    const watcher = new ReorgWatcher({
      store,
      blockSource: mkBlockSource({ head: 110n, reorgedTxs: [TX_A] }),
      chainId: 31337,
      reorgWindowBlocks: 32,
      now: () => new Date(5_000),
    });
    const summary = await watcher.tick();
    expect(summary.reorgedCount).toBe(1);

    const back = (await store.withTxn((txn) => Promise.resolve(txn.listBatches({}))))[0];
    expect(back!.status).toBe('reorged');
    expect(back!.invalidatedAt).toBe(5_000);
  });

  it('in-window reorg re-enqueues messages in original ingest order', async () => {
    const store = await createMemoryStore();
    await seedConfirmedBatch(store, {
        txHash: TX_A,
        contentTag: TAG,
        blobVersionedHash: BVH_A,
        batchContentHash: BCH_A,
        blockNumber: 100,
        submittedAt: 1_000,
        messages: [snapshot(2, 20), snapshot(1, 10), snapshot(3, 30)],
      });
    const watcher = new ReorgWatcher({
      store,
      blockSource: mkBlockSource({ head: 110n, reorgedTxs: [TX_A] }),
      chainId: 31337,
      reorgWindowBlocks: 32,
      now: () => new Date(5_000),
    });
    await watcher.tick();
    const rows = await store.withTxn((txn) =>
      Promise.resolve(txn.listPendingByTag(TAG))
    );
    // Re-enqueue order follows `originalIngestSeq` ascending.
    expect(rows.map((r) => Number(r.nonce))).toEqual([1, 2, 3]);
  });

  it('last-accepted-nonce tracker does NOT regress on reorg', async () => {
    const store = await createMemoryStore();
    await store.withTxn(async (txn) => txn.setNonce({
        sender: SENDER,
        lastNonce: 10n,
        lastMessageHash: ('0x' + 'aa'.repeat(32)) as Bytes32,
      }));
    await seedConfirmedBatch(store, {
        txHash: TX_A,
        contentTag: TAG,
        blobVersionedHash: BVH_A,
        batchContentHash: BCH_A,
        blockNumber: 100,
        submittedAt: 1_000,
        messages: [snapshot(1, 1)],
      });
    const watcher = new ReorgWatcher({
      store,
      blockSource: mkBlockSource({ head: 110n, reorgedTxs: [TX_A] }),
      chainId: 31337,
      reorgWindowBlocks: 32,
      now: () => new Date(5_000),
    });
    await watcher.tick();
    const tracker = await store.withTxn((txn) => Promise.resolve(txn.getNonce(SENDER)));
    expect(tracker!.lastNonce).toBe(10n); // unchanged; monotonic
  });

  it('out-of-window reorg is ignored (row stays included)', async () => {
    const store = await createMemoryStore();
    await seedConfirmedBatch(store, {
        txHash: TX_A,
        contentTag: TAG,
        blobVersionedHash: BVH_A,
        batchContentHash: BCH_A,
        blockNumber: 50,
        submittedAt: 1_000,
        messages: [snapshot(1, 1)],
      });
    const watcher = new ReorgWatcher({
      store,
      // Head 200, window 32 → windowStart = 168, row at block 50 falls
      // outside the window.
      blockSource: mkBlockSource({ head: 200n, reorgedTxs: [TX_A] }),
      chainId: 31337,
      reorgWindowBlocks: 32,
      now: () => new Date(5_000),
    });
    const summary = await watcher.tick();
    expect(summary.reorgedCount).toBe(0);
    const back = (await store.withTxn((txn) => Promise.resolve(txn.listBatches({}))))[0];
    expect(back!.status).toBe('confirmed');
  });

  it('tx still on chain keeps status included', async () => {
    const store = await createMemoryStore();
    await seedConfirmedBatch(store, {
        txHash: TX_A,
        contentTag: TAG,
        blobVersionedHash: BVH_A,
        batchContentHash: BCH_A,
        blockNumber: 100,
        submittedAt: 1_000,
        messages: [snapshot(1, 1)],
      });
    const watcher = new ReorgWatcher({
      store,
      blockSource: mkBlockSource({ head: 110n, reorgedTxs: [] }),
      chainId: 31337,
      reorgWindowBlocks: 32,
      now: () => new Date(5_000),
    });
    const summary = await watcher.tick();
    expect(summary.reorgedCount).toBe(0);
    expect(summary.keptCount).toBe(1);
  });

  it('re-enqueued messages become listable via listPendingByTag', async () => {
    const store = await createMemoryStore();
    await seedConfirmedBatch(store, {
        txHash: TX_A,
        contentTag: TAG,
        blobVersionedHash: BVH_A,
        batchContentHash: BCH_A,
        blockNumber: 100,
        submittedAt: 1_000,
        messages: [snapshot(5, 50)],
      });
    const watcher = new ReorgWatcher({
      store,
      blockSource: mkBlockSource({ head: 110n, reorgedTxs: [TX_A] }),
      chainId: 31337,
      reorgWindowBlocks: 32,
      now: () => new Date(5_000),
    });
    await watcher.tick();
    const rows = await store.withTxn((txn) =>
      Promise.resolve(txn.listPendingByTag(TAG))
    );
    expect(rows.length).toBe(1);
    expect(rows[0].messageHash).toBe(snapshot(5, 50).messageHash);
  });
});
