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
import { MemoryPosterStore } from '../../src/pool/memory-store.js';
import type { MessageSnapshot } from '../../src/types.js';

const TAG = ('0x' + 'aa'.repeat(32)) as Bytes32;
const SENDER = ('0x' + '11'.repeat(20)) as Address;
const TX_A = ('0x' + '01'.repeat(32)) as Bytes32;
const BVH_A = ('0x' + '02'.repeat(32)) as Bytes32;
const BCH_A = ('0x' + '03'.repeat(32)) as Bytes32;

function snapshot(nonce: number, seq: number): MessageSnapshot {
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
    const store = new MemoryPosterStore();
    const submittedAt = 1_000;
    await store.withTxn(async (txn) =>
      txn.insertSubmitted({
        txHash: TX_A,
        contentTag: TAG,
        blobVersionedHash: BVH_A,
        batchContentHash: BCH_A,
        blockNumber: 100,
        status: 'included',
        replacedByTxHash: null,
        submittedAt,
        invalidatedAt: null,
        messages: [snapshot(1, 1), snapshot(2, 2)],
      })
    );
    const watcher = new ReorgWatcher({
      store,
      blockSource: mkBlockSource({ head: 110n, reorgedTxs: [TX_A] }),
      reorgWindowBlocks: 32,
      now: () => new Date(5_000),
    });
    const summary = await watcher.tick();
    expect(summary.reorgedCount).toBe(1);

    const back = await store.withTxn((txn) => Promise.resolve(txn.getSubmittedByTx(TX_A)));
    expect(back!.status).toBe('reorged');
    expect(back!.invalidatedAt).toBe(5_000);
  });

  it('in-window reorg re-enqueues messages in original ingest order', async () => {
    const store = new MemoryPosterStore();
    await store.withTxn(async (txn) =>
      txn.insertSubmitted({
        txHash: TX_A,
        contentTag: TAG,
        blobVersionedHash: BVH_A,
        batchContentHash: BCH_A,
        blockNumber: 100,
        status: 'included',
        replacedByTxHash: null,
        submittedAt: 1_000,
        invalidatedAt: null,
        messages: [snapshot(2, 20), snapshot(1, 10), snapshot(3, 30)],
      })
    );
    const watcher = new ReorgWatcher({
      store,
      blockSource: mkBlockSource({ head: 110n, reorgedTxs: [TX_A] }),
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
    const store = new MemoryPosterStore();
    await store.withTxn(async (txn) => {
      txn.setNonce({
        sender: SENDER,
        lastNonce: 10n,
        lastMessageHash: ('0x' + 'aa'.repeat(32)) as Bytes32,
      });
      txn.insertSubmitted({
        txHash: TX_A,
        contentTag: TAG,
        blobVersionedHash: BVH_A,
        batchContentHash: BCH_A,
        blockNumber: 100,
        status: 'included',
        replacedByTxHash: null,
        submittedAt: 1_000,
        invalidatedAt: null,
        messages: [snapshot(1, 1)],
      });
    });
    const watcher = new ReorgWatcher({
      store,
      blockSource: mkBlockSource({ head: 110n, reorgedTxs: [TX_A] }),
      reorgWindowBlocks: 32,
      now: () => new Date(5_000),
    });
    await watcher.tick();
    const tracker = await store.withTxn((txn) => Promise.resolve(txn.getNonce(SENDER)));
    expect(tracker!.lastNonce).toBe(10n); // unchanged; monotonic
  });

  it('out-of-window reorg is ignored (row stays included)', async () => {
    const store = new MemoryPosterStore();
    await store.withTxn(async (txn) =>
      txn.insertSubmitted({
        txHash: TX_A,
        contentTag: TAG,
        blobVersionedHash: BVH_A,
        batchContentHash: BCH_A,
        blockNumber: 50,
        status: 'included',
        replacedByTxHash: null,
        submittedAt: 1_000,
        invalidatedAt: null,
        messages: [snapshot(1, 1)],
      })
    );
    const watcher = new ReorgWatcher({
      store,
      // Head 200, window 32 → windowStart = 168, row at block 50 falls
      // outside the window.
      blockSource: mkBlockSource({ head: 200n, reorgedTxs: [TX_A] }),
      reorgWindowBlocks: 32,
      now: () => new Date(5_000),
    });
    const summary = await watcher.tick();
    expect(summary.reorgedCount).toBe(0);
    const back = await store.withTxn((txn) => Promise.resolve(txn.getSubmittedByTx(TX_A)));
    expect(back!.status).toBe('included');
  });

  it('tx still on chain keeps status included', async () => {
    const store = new MemoryPosterStore();
    await store.withTxn(async (txn) =>
      txn.insertSubmitted({
        txHash: TX_A,
        contentTag: TAG,
        blobVersionedHash: BVH_A,
        batchContentHash: BCH_A,
        blockNumber: 100,
        status: 'included',
        replacedByTxHash: null,
        submittedAt: 1_000,
        invalidatedAt: null,
        messages: [snapshot(1, 1)],
      })
    );
    const watcher = new ReorgWatcher({
      store,
      blockSource: mkBlockSource({ head: 110n, reorgedTxs: [] }),
      reorgWindowBlocks: 32,
      now: () => new Date(5_000),
    });
    const summary = await watcher.tick();
    expect(summary.reorgedCount).toBe(0);
    expect(summary.keptCount).toBe(1);
  });

  it('re-enqueued messages become listable via listPendingByTag', async () => {
    const store = new MemoryPosterStore();
    await store.withTxn(async (txn) =>
      txn.insertSubmitted({
        txHash: TX_A,
        contentTag: TAG,
        blobVersionedHash: BVH_A,
        batchContentHash: BCH_A,
        blockNumber: 100,
        status: 'included',
        replacedByTxHash: null,
        submittedAt: 1_000,
        invalidatedAt: null,
        messages: [snapshot(5, 50)],
      })
    );
    const watcher = new ReorgWatcher({
      store,
      blockSource: mkBlockSource({ head: 110n, reorgedTxs: [TX_A] }),
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
