import { describe, it, expect } from 'vitest';
import type { Address, Bytes32 } from 'bam-sdk';

import { MemoryPosterStore } from '../../src/pool/memory-store.js';
import {
  DEFAULT_REORG_WINDOW,
  MAX_REORG_WINDOW,
  MIN_REORG_WINDOW,
  ReorgWatcher,
  clampReorgWindow,
  type BlockSource,
} from '../../src/submission/reorg-watcher.js';
import type { MessageSnapshot, StoreTxnSubmittedRow } from '../../src/types.js';

const TAG = ('0x' + 'aa'.repeat(32)) as Bytes32;
const AUTHOR = '0x1111111111111111111111111111111111111111' as Address;

function snap(i: number, ingestSeq: number): MessageSnapshot {
  return {
    messageId: (`0x${i.toString(16).padStart(64, '0')}`) as Bytes32,
    author: AUTHOR,
    nonce: BigInt(i),
    timestamp: 1_700_000_000 + i,
    content: `msg-${i}`,
    signature: new Uint8Array(65),
    originalIngestSeq: ingestSeq,
  };
}

function submittedRow(
  overrides: Partial<StoreTxnSubmittedRow> = {}
): StoreTxnSubmittedRow {
  const messages = overrides.messages ?? [snap(1, 1), snap(2, 2), snap(3, 3)];
  return {
    txHash: ('0x' + 'dd'.repeat(32)) as Bytes32,
    contentTag: TAG,
    blobVersionedHash: ('0x' + 'ee'.repeat(32)) as Bytes32,
    blockNumber: 100,
    status: 'included',
    replacedByTxHash: null,
    submittedAt: 1_700_000_000_000,
    messageIds: messages.map((m) => m.messageId),
    messages,
    ...overrides,
  };
}

class FakeBlockSource implements BlockSource {
  constructor(
    public head: bigint,
    private readonly txBlocks: Map<Bytes32, number | null>
  ) {}
  async getBlockNumber(): Promise<bigint> {
    return this.head;
  }
  async getTransactionBlock(txHash: Bytes32): Promise<number | null> {
    const v = this.txBlocks.get(txHash);
    return v === undefined ? null : v;
  }
}

describe('clampReorgWindow', () => {
  it('clamps to [4, 128] with a sensible default on NaN/infinite', () => {
    expect(clampReorgWindow(1)).toBe(MIN_REORG_WINDOW);
    expect(clampReorgWindow(10_000)).toBe(MAX_REORG_WINDOW);
    expect(clampReorgWindow(32)).toBe(32);
    expect(clampReorgWindow(Number.NaN)).toBe(DEFAULT_REORG_WINDOW);
    expect(clampReorgWindow(Number.POSITIVE_INFINITY)).toBe(DEFAULT_REORG_WINDOW);
  });
});

describe('ReorgWatcher', () => {
  it('on reorg within window: marks entry reorged + re-enqueues in original ingest order', async () => {
    const store = new MemoryPosterStore();
    const row = submittedRow();
    await store.withTxn(async (txn) => {
      await txn.insertSubmitted(row);
    });
    const source = new FakeBlockSource(120n, new Map([[row.txHash, null]]));
    const watcher = new ReorgWatcher({
      store,
      blockSource: source,
      reorgWindowBlocks: 32,
      now: () => new Date(1_700_000_000_000),
    });

    const result = await watcher.tick();
    expect(result.reorgedCount).toBe(1);

    const updated = await store.withTxn(async (txn) => txn.getSubmittedByTx(row.txHash));
    expect(updated!.status).toBe('reorged');

    const pending = await store.withTxn(async (txn) => txn.listPendingByTag(TAG));
    expect(pending).toHaveLength(3);
    // Re-enqueue preserves the original ingest order.
    expect(pending.map((p) => p.messageId)).toEqual([
      row.messages[0].messageId,
      row.messages[1].messageId,
      row.messages[2].messageId,
    ]);
  });

  it('does not regress poster_nonces on reorg', async () => {
    const store = new MemoryPosterStore();
    const row = submittedRow();
    await store.withTxn(async (txn) => {
      await txn.insertSubmitted(row);
      await txn.setNonce({
        author: AUTHOR,
        lastNonce: 3n,
        lastMessageId: row.messages[2].messageId,
      });
    });
    const source = new FakeBlockSource(115n, new Map([[row.txHash, null]]));
    const watcher = new ReorgWatcher({
      store,
      blockSource: source,
      reorgWindowBlocks: 32,
      now: () => new Date(1_700_000_000_000),
    });

    await watcher.tick();
    const nonce = await store.withTxn(async (txn) => txn.getNonce(AUTHOR));
    expect(nonce!.lastNonce).toBe(3n);
  });

  it('out-of-window reorg: no re-enqueue, no status change', async () => {
    const store = new MemoryPosterStore();
    const row = submittedRow({ blockNumber: 50 });
    await store.withTxn(async (txn) => {
      await txn.insertSubmitted(row);
    });
    const source = new FakeBlockSource(500n, new Map([[row.txHash, null]]));
    const watcher = new ReorgWatcher({
      store,
      blockSource: source,
      reorgWindowBlocks: 32, // window = [468, 500]; row at 50 is out
      now: () => new Date(1_700_000_000_000),
    });
    const result = await watcher.tick();
    expect(result.reorgedCount).toBe(0);
    const updated = await store.withTxn(async (txn) => txn.getSubmittedByTx(row.txHash));
    expect(updated!.status).toBe('included'); // unchanged
    const pending = await store.withTxn(async (txn) => txn.listPendingByTag(TAG));
    expect(pending).toHaveLength(0);
  });

  it('in-window but tx still on chain: no re-enqueue', async () => {
    const store = new MemoryPosterStore();
    const row = submittedRow();
    await store.withTxn(async (txn) => {
      await txn.insertSubmitted(row);
    });
    const source = new FakeBlockSource(110n, new Map([[row.txHash, 100]]));
    const watcher = new ReorgWatcher({
      store,
      blockSource: source,
      reorgWindowBlocks: 32,
      now: () => new Date(1_700_000_000_000),
    });
    const result = await watcher.tick();
    expect(result.reorgedCount).toBe(0);
    expect(result.keptCount).toBe(1);
  });

  it('does not double-enqueue if a message is already pending (e.g. byte-equal retry)', async () => {
    const store = new MemoryPosterStore();
    const msg = snap(1, 1);
    const row = submittedRow({ messages: [msg], messageIds: [msg.messageId] });
    await store.withTxn(async (txn) => {
      await txn.insertSubmitted(row);
      await txn.insertPending({
        messageId: msg.messageId,
        contentTag: TAG,
        author: msg.author,
        nonce: msg.nonce,
        timestamp: msg.timestamp,
        content: new TextEncoder().encode(msg.content),
        signature: msg.signature,
        ingestedAt: 1_700_000_000_000,
        ingestSeq: await txn.nextIngestSeq(TAG),
      });
    });
    const source = new FakeBlockSource(110n, new Map([[row.txHash, null]]));
    const watcher = new ReorgWatcher({
      store,
      blockSource: source,
      reorgWindowBlocks: 32,
      now: () => new Date(1_700_000_000_000),
    });
    await watcher.tick();
    const pending = await store.withTxn(async (txn) => txn.listPendingByTag(TAG));
    expect(pending).toHaveLength(1);
  });
});
