import type { Address, Bytes32 } from 'bam-sdk';
import { createMemoryStore } from 'bam-store';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_REORG_WINDOW,
  MAX_REORG_WINDOW,
  MIN_REORG_WINDOW,
  ReaderReorgWatcher,
  clampReorgWindow,
  type BlockSource,
} from '../../src/reorg-watcher.js';

const CHAIN_ID = 11155111;
const TAG = ('0x' + 'aa'.repeat(32)) as Bytes32;
const SUBMITTER = '0x000000000000000000000000000000000000ab12' as Address;

function makeBatch(opts: {
  txHash: Bytes32;
  blockNumber: number;
  chainId?: number;
}) {
  return {
    txHash: opts.txHash,
    chainId: opts.chainId ?? CHAIN_ID,
    contentTag: TAG,
    blobVersionedHash: opts.txHash,
    batchContentHash: opts.txHash,
    blockNumber: opts.blockNumber,
    txIndex: 0,
    status: 'confirmed' as const,
    replacedByTxHash: null,
    submittedAt: 0,
    invalidatedAt: null,
    messageSnapshot: [],
  };
}

function fakeBlockSource(opts: {
  head: number;
  reorgedTxHashes: Set<Bytes32>;
}): BlockSource {
  return {
    async getBlockNumber() {
      return BigInt(opts.head);
    },
    async getTransactionBlock(txHash) {
      return opts.reorgedTxHashes.has(txHash) ? null : opts.head - 5;
    },
  };
}

describe('clampReorgWindow', () => {
  it('clamps to [MIN_REORG_WINDOW, MAX_REORG_WINDOW]', () => {
    expect(clampReorgWindow(2)).toBe(MIN_REORG_WINDOW);
    expect(clampReorgWindow(1000)).toBe(MAX_REORG_WINDOW);
    expect(clampReorgWindow(64)).toBe(64);
  });
  it('falls back to DEFAULT_REORG_WINDOW on non-finite input', () => {
    expect(clampReorgWindow(Number.NaN)).toBe(DEFAULT_REORG_WINDOW);
    expect(clampReorgWindow(Infinity)).toBe(DEFAULT_REORG_WINDOW);
  });
});

describe('ReaderReorgWatcher.tick', () => {
  it('leaves an in-window confirmed batch untouched when the tx is still on chain', async () => {
    const store = createMemoryStore();
    const tx = ('0x' + 'aa'.repeat(32)) as Bytes32;
    await store.withTxn(async (txn) =>
      txn.upsertBatch(makeBatch({ txHash: tx, blockNumber: 95 }))
    );
    const watcher = new ReaderReorgWatcher({
      store,
      blockSource: fakeBlockSource({ head: 100, reorgedTxHashes: new Set() }),
      chainId: CHAIN_ID,
      reorgWindowBlocks: 32,
    });
    const { keptCount, reorgedCount } = await watcher.tick();
    expect(keptCount).toBe(1);
    expect(reorgedCount).toBe(0);
    const batches = await store.withTxn(async (txn) =>
      txn.listBatches({ chainId: CHAIN_ID })
    );
    expect(batches[0].status).toBe('confirmed');
  });

  it('marks an in-window batch reorged when its tx no longer resolves', async () => {
    const store = createMemoryStore();
    const tx = ('0x' + 'bb'.repeat(32)) as Bytes32;
    await store.withTxn(async (txn) =>
      txn.upsertBatch(makeBatch({ txHash: tx, blockNumber: 95 }))
    );
    const watcher = new ReaderReorgWatcher({
      store,
      blockSource: fakeBlockSource({ head: 100, reorgedTxHashes: new Set([tx]) }),
      chainId: CHAIN_ID,
      reorgWindowBlocks: 32,
      now: () => new Date(1234),
    });
    const { reorgedCount, keptCount } = await watcher.tick();
    expect(reorgedCount).toBe(1);
    expect(keptCount).toBe(0);
    const batches = await store.withTxn(async (txn) =>
      txn.listBatches({ chainId: CHAIN_ID, status: 'reorged' })
    );
    expect(batches.length).toBe(1);
    expect(batches[0].invalidatedAt).toBe(1234);
  });

  it('ignores out-of-window batches even if their tx is no longer on chain', async () => {
    const store = createMemoryStore();
    const tx = ('0x' + 'cc'.repeat(32)) as Bytes32;
    await store.withTxn(async (txn) =>
      txn.upsertBatch(makeBatch({ txHash: tx, blockNumber: 10 })) // far below head-window
    );
    const watcher = new ReaderReorgWatcher({
      store,
      blockSource: fakeBlockSource({ head: 200, reorgedTxHashes: new Set([tx]) }),
      chainId: CHAIN_ID,
      reorgWindowBlocks: 32,
    });
    const { reorgedCount, keptCount } = await watcher.tick();
    expect(reorgedCount).toBe(0);
    expect(keptCount).toBe(0);
    const batches = await store.withTxn(async (txn) =>
      txn.listBatches({ chainId: CHAIN_ID })
    );
    expect(batches[0].status).toBe('confirmed');
  });

  it('only considers batches matching the configured chainId', async () => {
    const store = createMemoryStore();
    const txMine = ('0x' + 'dd'.repeat(32)) as Bytes32;
    const txOther = ('0x' + 'ee'.repeat(32)) as Bytes32;
    await store.withTxn(async (txn) => {
      await txn.upsertBatch(makeBatch({ txHash: txMine, blockNumber: 95 }));
      await txn.upsertBatch(
        makeBatch({ txHash: txOther, blockNumber: 95, chainId: 1 })
      );
    });
    const watcher = new ReaderReorgWatcher({
      store,
      blockSource: fakeBlockSource({
        head: 100,
        reorgedTxHashes: new Set([txMine, txOther]),
      }),
      chainId: CHAIN_ID,
      reorgWindowBlocks: 32,
    });
    const { reorgedCount } = await watcher.tick();
    expect(reorgedCount).toBe(1);
    const reorged = await store.withTxn(async (txn) =>
      txn.listBatches({ status: 'reorged' })
    );
    expect(reorged.map((b) => b.txHash)).toEqual([txMine]);
  });

  // Reader-side divergence from Poster: no re-enqueue.
  it('does not re-enqueue messages of a reorged batch to pending', async () => {
    const store = createMemoryStore();
    const tx = ('0x' + 'ff'.repeat(32)) as Bytes32;
    const author = '0x000000000000000000000000000000000000aaaa' as Address;
    await store.withTxn(async (txn) => {
      await txn.upsertBatch(makeBatch({ txHash: tx, blockNumber: 95 }));
      await txn.upsertObserved({
        messageId: ('0x' + '11'.repeat(32)) as Bytes32,
        author,
        nonce: 1n,
        contentTag: TAG,
        contents: new Uint8Array(32),
        signature: new Uint8Array(65),
        messageHash: ('0x' + '22'.repeat(32)) as Bytes32,
        status: 'confirmed',
        batchRef: tx,
        ingestedAt: null,
        ingestSeq: null,
        blockNumber: 95,
        txIndex: 0,
        messageIndexWithinBatch: 0,
      });
    });
    const watcher = new ReaderReorgWatcher({
      store,
      blockSource: fakeBlockSource({ head: 100, reorgedTxHashes: new Set([tx]) }),
      chainId: CHAIN_ID,
      reorgWindowBlocks: 32,
    });
    await watcher.tick();
    const pending = await store.withTxn(async (txn) =>
      txn.listMessages({ status: 'pending' })
    );
    expect(pending.length).toBe(0);
    const reorgedRows = await store.withTxn(async (txn) =>
      txn.listMessages({ status: 'reorged' })
    );
    expect(reorgedRows.length).toBe(1);
  });
});
