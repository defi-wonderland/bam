/**
 * Shared conformance suite — the body run against every backend
 * (PGLite in-memory, real Postgres when `BAM_TEST_PG_URL` is set).
 * Each backend that passes every case here is a conforming `BamStore`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { Address, Bytes32 } from 'bam-sdk';

import type {
  BamStore,
  BatchMessageSnapshotEntry,
  BatchRow,
  MessageRow,
} from '../src/types.js';

export type StoreFactory = () => BamStore | Promise<BamStore>;

const TAG_A = ('0x' + 'aa'.repeat(32)) as Bytes32;
const ADDR_1 = ('0x' + '11'.repeat(20)) as Address;
const ADDR_2 = ('0x' + '22'.repeat(20)) as Address;
const TX_A = ('0x' + '01'.repeat(32)) as Bytes32;
const TX_B = ('0x' + '02'.repeat(32)) as Bytes32;
const BVH = ('0x' + '03'.repeat(32)) as Bytes32;
const BCH = ('0x' + '04'.repeat(32)) as Bytes32;
const MID_1 = ('0x' + '99'.repeat(32)) as Bytes32;
const MHASH_1 = ('0x' + '77'.repeat(32)) as Bytes32;

function messageRow(overrides: Partial<MessageRow> = {}): MessageRow {
  const contents = new Uint8Array(40);
  contents.fill(0xaa, 0, 32);
  return {
    messageId: null,
    author: ADDR_1,
    nonce: 1n,
    contentTag: TAG_A,
    contents,
    signature: new Uint8Array(65),
    messageHash: MHASH_1,
    status: 'pending',
    batchRef: null,
    ingestedAt: null,
    ingestSeq: null,
    blockNumber: null,
    txIndex: null,
    messageIndexWithinBatch: null,
    ...overrides,
  };
}

function snapshotEntry(
  overrides: Partial<BatchMessageSnapshotEntry> = {}
): BatchMessageSnapshotEntry {
  return {
    author: ADDR_1,
    nonce: 1n,
    messageId: MID_1,
    messageHash: MHASH_1,
    messageIndexWithinBatch: 0,
    ...overrides,
  };
}

function batchRow(overrides: Partial<BatchRow> = {}): BatchRow {
  return {
    txHash: TX_A,
    chainId: 1,
    contentTag: TAG_A,
    blobVersionedHash: BVH,
    batchContentHash: BCH,
    blockNumber: null,
    txIndex: null,
    status: 'pending_tx',
    replacedByTxHash: null,
    submittedAt: 1_000,
    invalidatedAt: null,
    messageSnapshot: [],
    ...overrides,
  };
}

export function runConformance(make: StoreFactory): void {
  const created: BamStore[] = [];
  async function newStore(): Promise<BamStore> {
    const s = await make();
    created.push(s);
    return s;
  }
  afterEach(async () => {
    for (const s of created.splice(0)) await s.close();
  });

  describe('upsert-observed idempotency on (author, nonce)', () => {
    it('second upsert with same (author, nonce) and matching messageHash is a no-op', async () => {
      const store = await newStore();
      const row = messageRow({
        status: 'confirmed',
        batchRef: TX_A,
        blockNumber: 10,
        txIndex: 0,
        messageIndexWithinBatch: 0,
        messageId: MID_1,
      });
      await store.withTxn((txn) => txn.upsertBatch(batchRow({ status: 'confirmed', blockNumber: 10 })));
      await store.withTxn((txn) => txn.upsertObserved(row));
      await store.withTxn((txn) => txn.upsertObserved(row));
      const back = await store.withTxn((txn) => txn.getByAuthorNonce(ADDR_1, 1n));
      expect(back).not.toBeNull();
      expect(back!.status).toBe('confirmed');
    });

    it('upsert on a row whose confirmed messageHash differs rejects', async () => {
      const store = await newStore();
      const first = messageRow({
        status: 'confirmed',
        messageHash: ('0x' + '11'.repeat(32)) as Bytes32,
        batchRef: TX_A,
        blockNumber: 10,
        txIndex: 0,
        messageIndexWithinBatch: 0,
      });
      await store.withTxn((txn) => txn.upsertBatch(batchRow({ status: 'confirmed', blockNumber: 10 })));
      await store.withTxn((txn) => txn.upsertObserved(first));
      const second = messageRow({
        status: 'confirmed',
        messageHash: ('0x' + '22'.repeat(32)) as Bytes32,
      });
      await expect(
        store.withTxn((txn) => txn.upsertObserved(second))
      ).rejects.toThrow();
    });

    it('matching-bytes guard also applies to pending/submitted/reorged rows', async () => {
      const store = await newStore();
      const mhash = ('0x' + '11'.repeat(32)) as Bytes32;
      // Pending row with one messageHash.
      await store.withTxn((txn) =>
        txn.insertPending({
          contentTag: TAG_A,
          sender: ADDR_1,
          nonce: 1n,
          contents: new Uint8Array(40),
          signature: new Uint8Array(65),
          messageHash: mhash,
          ingestedAt: 1_000,
          ingestSeq: 1,
        })
      );
      // Upsert at same (author, nonce) but with different bytes must reject
      // even though the existing row is NOT confirmed.
      const mismatching = messageRow({
        status: 'confirmed',
        messageHash: ('0x' + '22'.repeat(32)) as Bytes32,
      });
      await expect(
        store.withTxn((txn) => txn.upsertObserved(mismatching))
      ).rejects.toThrow();
    });

    it('matching-bytes upsert on a pending row transitions it to confirmed', async () => {
      const store = await newStore();
      const mhash = ('0x' + '11'.repeat(32)) as Bytes32;
      await store.withTxn((txn) =>
        txn.insertPending({
          contentTag: TAG_A,
          sender: ADDR_1,
          nonce: 1n,
          contents: new Uint8Array(40),
          signature: new Uint8Array(65),
          messageHash: mhash,
          ingestedAt: 1_000,
          ingestSeq: 1,
        })
      );
      await store.withTxn((txn) =>
        txn.upsertBatch(batchRow({ status: 'confirmed', blockNumber: 10 }))
      );
      await store.withTxn((txn) =>
        txn.upsertObserved(
          messageRow({
            messageHash: mhash,
            status: 'confirmed',
            batchRef: TX_A,
            blockNumber: 10,
            txIndex: 0,
            messageIndexWithinBatch: 0,
            messageId: MID_1,
          })
        )
      );
      const back = await store.withTxn((txn) => txn.getByAuthorNonce(ADDR_1, 1n));
      expect(back!.status).toBe('confirmed');
      expect(back!.messageId).toBe(MID_1);
    });
  });

  describe('markReorged cascade', () => {
    it('batch flips to reorged and every confirmed row under it cascades to reorged', async () => {
      const store = await newStore();
      await store.withTxn(async (txn) => {
        await txn.upsertBatch(batchRow({ status: 'confirmed', blockNumber: 10 }));
        await txn.upsertObserved(
          messageRow({
            status: 'confirmed',
            batchRef: TX_A,
            blockNumber: 10,
            txIndex: 0,
            messageIndexWithinBatch: 0,
            author: ADDR_1,
            nonce: 1n,
          })
        );
        await txn.upsertObserved(
          messageRow({
            status: 'confirmed',
            batchRef: TX_A,
            blockNumber: 10,
            txIndex: 0,
            messageIndexWithinBatch: 1,
            author: ADDR_2,
            nonce: 1n,
          })
        );
      });
      await store.withTxn((txn) => txn.markReorged(TX_A, 5_000));
      const batches = await store.withTxn((txn) => txn.listBatches({}));
      expect(batches[0].status).toBe('reorged');
      expect(batches[0].invalidatedAt).toBe(5_000);
      const r1 = await store.withTxn((txn) => txn.getByAuthorNonce(ADDR_1, 1n));
      const r2 = await store.withTxn((txn) => txn.getByAuthorNonce(ADDR_2, 1n));
      expect(r1!.status).toBe('reorged');
      expect(r2!.status).toBe('reorged');
    });
  });

  describe('chain-derived ordering from listMessages', () => {
    it('observed rows sort by (blockNumber, txIndex, messageIndexWithinBatch)', async () => {
      const store = await newStore();
      await store.withTxn(async (txn) => {
        await txn.upsertBatch(batchRow({ txHash: TX_A, blockNumber: 10 }));
        await txn.upsertBatch(batchRow({ txHash: TX_B, blockNumber: 20 }));
        await txn.upsertObserved(
          messageRow({ author: ADDR_1, nonce: 1n, batchRef: TX_B, blockNumber: 20, txIndex: 0, messageIndexWithinBatch: 0 })
        );
        await txn.upsertObserved(
          messageRow({ author: ADDR_2, nonce: 1n, batchRef: TX_A, blockNumber: 10, txIndex: 3, messageIndexWithinBatch: 1 })
        );
        await txn.upsertObserved(
          messageRow({ author: ADDR_1, nonce: 2n, batchRef: TX_A, blockNumber: 10, txIndex: 3, messageIndexWithinBatch: 0 })
        );
      });
      const rows = await store.withTxn((txn) => txn.listMessages({}));
      const coords = rows.map((r) => [r.blockNumber, r.txIndex, r.messageIndexWithinBatch]);
      expect(coords).toEqual([
        [10, 3, 0],
        [10, 3, 1],
        [20, 0, 0],
      ]);
    });

    it('cursor pagination resumes strictly after the given coord', async () => {
      const store = await newStore();
      await store.withTxn(async (txn) => {
        await txn.upsertObserved(
          messageRow({ author: ADDR_1, nonce: 1n, blockNumber: 10, txIndex: 0, messageIndexWithinBatch: 0 })
        );
        await txn.upsertObserved(
          messageRow({ author: ADDR_1, nonce: 2n, blockNumber: 10, txIndex: 0, messageIndexWithinBatch: 1 })
        );
        await txn.upsertObserved(
          messageRow({ author: ADDR_1, nonce: 3n, blockNumber: 11, txIndex: 0, messageIndexWithinBatch: 0 })
        );
      });
      const rows = await store.withTxn((txn) =>
        txn.listMessages({
          cursor: { blockNumber: 10, txIndex: 0, messageIndexWithinBatch: 0 },
        })
      );
      expect(rows.length).toBe(2);
      expect(rows[0].nonce).toBe(2n);
      expect(rows[1].nonce).toBe(3n);
    });
  });

  describe('batch status transitions', () => {
    it('pending_tx → confirmed on updateBatchStatus with block_number', async () => {
      const store = await newStore();
      await store.withTxn((txn) => txn.upsertBatch(batchRow({ status: 'pending_tx' })));
      await store.withTxn((txn) =>
        txn.updateBatchStatus(TX_A, 'confirmed', { blockNumber: 42, txIndex: 3 })
      );
      const [b] = await store.withTxn((txn) => txn.listBatches({}));
      expect(b.status).toBe('confirmed');
      expect(b.blockNumber).toBe(42);
      expect(b.txIndex).toBe(3);
    });

    it('confirmed → reorged via updateBatchStatus with invalidatedAt', async () => {
      const store = await newStore();
      await store.withTxn((txn) =>
        txn.upsertBatch(batchRow({ status: 'confirmed', blockNumber: 10 }))
      );
      await store.withTxn((txn) =>
        txn.updateBatchStatus(TX_A, 'reorged', { invalidatedAt: 9_000 })
      );
      const [b] = await store.withTxn((txn) => txn.listBatches({}));
      expect(b.status).toBe('reorged');
      expect(b.invalidatedAt).toBe(9_000);
    });
  });

  describe('reader cursor get/set', () => {
    it('getCursor on a fresh chain returns null; set+get round-trips; overwrite', async () => {
      const store = await newStore();
      const miss = await store.withTxn((txn) => txn.getCursor(1));
      expect(miss).toBeNull();
      await store.withTxn((txn) =>
        txn.setCursor({ chainId: 1, lastBlockNumber: 100, lastTxIndex: 5, updatedAt: 1_000 })
      );
      const hit = await store.withTxn((txn) => txn.getCursor(1));
      expect(hit).toEqual({ chainId: 1, lastBlockNumber: 100, lastTxIndex: 5, updatedAt: 1_000 });
      await store.withTxn((txn) =>
        txn.setCursor({ chainId: 1, lastBlockNumber: 200, lastTxIndex: 0, updatedAt: 2_000 })
      );
      const updated = await store.withTxn((txn) => txn.getCursor(1));
      expect(updated!.lastBlockNumber).toBe(200);
    });
  });

  describe('batch messageSnapshot', () => {
    it('round-trips multi-entry snapshot through upsertBatch + listBatches', async () => {
      const store = await newStore();
      const snap: BatchMessageSnapshotEntry[] = [
        snapshotEntry({ author: ADDR_1, nonce: 1n, messageIndexWithinBatch: 0, messageId: ('0x' + 'a1'.repeat(32)) as Bytes32 }),
        snapshotEntry({ author: ADDR_2, nonce: 7n, messageIndexWithinBatch: 1, messageId: ('0x' + 'b2'.repeat(32)) as Bytes32, messageHash: ('0x' + '88'.repeat(32)) as Bytes32 }),
      ];
      await store.withTxn((txn) =>
        txn.upsertBatch(batchRow({ status: 'confirmed', blockNumber: 10, messageSnapshot: snap }))
      );
      const [b] = await store.withTxn((txn) => txn.listBatches({}));
      expect(b.messageSnapshot).toHaveLength(2);
      expect(b.messageSnapshot[0].author.toLowerCase()).toBe(ADDR_1.toLowerCase());
      expect(b.messageSnapshot[0].nonce).toBe(1n);
      expect(b.messageSnapshot[1].nonce).toBe(7n);
      expect(b.messageSnapshot[1].messageIndexWithinBatch).toBe(1);
    });

    it('a non-empty snapshot is preserved when a later writer upserts with empty snapshot', async () => {
      const store = await newStore();
      const snap: BatchMessageSnapshotEntry[] = [snapshotEntry()];
      await store.withTxn((txn) =>
        txn.upsertBatch(batchRow({ status: 'confirmed', blockNumber: 10, messageSnapshot: snap }))
      );
      // Second writer upserts the same batch with an empty snapshot
      // (e.g. a Reader observes the batch metadata but hasn't decoded it).
      await store.withTxn((txn) =>
        txn.upsertBatch(batchRow({ status: 'confirmed', blockNumber: 10, messageSnapshot: [] }))
      );
      const [b] = await store.withTxn((txn) => txn.listBatches({}));
      expect(b.messageSnapshot).toHaveLength(1);
      expect(b.messageSnapshot[0].nonce).toBe(1n);
    });

    it('upsertBatch COALESCEs submittedAt + replacedByTxHash so a null second-writer does not clobber', async () => {
      const store = await newStore();
      // First writer sets submittedAt and replacedByTxHash to non-null.
      await store.withTxn((txn) =>
        txn.upsertBatch(
          batchRow({
            status: 'reorged',
            blockNumber: 10,
            submittedAt: 1_234,
            replacedByTxHash: TX_B,
          })
        )
      );
      // Second writer passes nulls for both.
      await store.withTxn((txn) =>
        txn.upsertBatch(
          batchRow({
            status: 'reorged',
            blockNumber: 10,
            submittedAt: null,
            replacedByTxHash: null,
          })
        )
      );
      const [b] = await store.withTxn((txn) => txn.listBatches({}));
      expect(b.submittedAt).toBe(1_234);
      expect(b.replacedByTxHash).toBe(TX_B);
    });
  });

  describe('getBatchByTxHash', () => {
    it('returns the same row that listBatches would, and null for an unknown hash', async () => {
      const store = await newStore();
      const snap: BatchMessageSnapshotEntry[] = [snapshotEntry()];
      await store.withTxn((txn) =>
        txn.upsertBatch(
          batchRow({ txHash: TX_A, status: 'confirmed', blockNumber: 10, messageSnapshot: snap })
        )
      );
      await store.withTxn((txn) =>
        txn.upsertBatch(
          batchRow({ txHash: TX_B, status: 'confirmed', blockNumber: 20 })
        )
      );

      const fromList = await store.withTxn((txn) =>
        txn.listBatches({ contentTag: TAG_A })
      );
      const targetA = fromList.find((b) => b.txHash === TX_A) ?? null;
      expect(targetA).not.toBeNull();

      const direct = await store.withTxn((txn) => txn.getBatchByTxHash(1, TX_A));
      expect(direct).not.toBeNull();
      expect(direct).toEqual(targetA);

      const missing = await store.withTxn((txn) =>
        txn.getBatchByTxHash(1, ('0x' + 'ee'.repeat(32)) as Bytes32)
      );
      expect(missing).toBeNull();

      // Cross-chain isolation: same txHash on a different chainId
      // must not return the row.
      const wrongChain = await store.withTxn((txn) =>
        txn.getBatchByTxHash(999, TX_A)
      );
      expect(wrongChain).toBeNull();
    });
  });

  describe('listBatches — ordering with null submittedAt (Reader-only deploys)', () => {
    it('orders by (blockNumber, txIndex) DESC when submittedAt is null', async () => {
      // The Reader leaves `submittedAt` null when it confirms a
      // batch (the Poster is the only writer that sets it). All
      // rows in a Reader-only deploy share `submittedAt = null`,
      // so ordering must fall back to L1 keys instead of being
      // backend-defined.
      const store = await newStore();
      const TX_LO = ('0x' + 'a1'.repeat(32)) as Bytes32;
      const TX_HI = ('0x' + 'a2'.repeat(32)) as Bytes32;
      const TX_HI_LATER_TX = ('0x' + 'a3'.repeat(32)) as Bytes32;
      await store.withTxn((txn) =>
        txn.upsertBatch(
          batchRow({
            txHash: TX_LO,
            status: 'confirmed',
            blockNumber: 100,
            txIndex: 0,
            submittedAt: null,
          })
        )
      );
      await store.withTxn((txn) =>
        txn.upsertBatch(
          batchRow({
            txHash: TX_HI,
            status: 'confirmed',
            blockNumber: 200,
            txIndex: 0,
            submittedAt: null,
          })
        )
      );
      await store.withTxn((txn) =>
        txn.upsertBatch(
          batchRow({
            txHash: TX_HI_LATER_TX,
            status: 'confirmed',
            blockNumber: 200,
            txIndex: 5,
            submittedAt: null,
          })
        )
      );
      const rows = await store.withTxn((txn) =>
        txn.listBatches({ contentTag: TAG_A })
      );
      expect(rows.map((r) => r.txHash)).toEqual([TX_HI_LATER_TX, TX_HI, TX_LO]);
    });
  });

  describe('cross-component write interleaving in one withTxn', () => {
    it('Poster marks submitted while Reader upserts observed; both persist without loss', async () => {
      const store = await newStore();
      await store.withTxn(async (txn) => {
        await txn.insertPending({
          contentTag: TAG_A,
          sender: ADDR_1,
          nonce: 1n,
          contents: new Uint8Array(40),
          signature: new Uint8Array(65),
          messageHash: MHASH_1,
          ingestedAt: 1_000,
          ingestSeq: 1,
        });
        await txn.upsertBatch(batchRow({ txHash: TX_A, status: 'pending_tx' }));
        await txn.markSubmitted([{ sender: ADDR_1, nonce: 1n }], TX_A);
        await txn.upsertObserved(
          messageRow({
            author: ADDR_2,
            nonce: 5n,
            status: 'confirmed',
            batchRef: TX_B,
            blockNumber: 10,
            txIndex: 0,
            messageIndexWithinBatch: 0,
          })
        );
      });
      const poster = await store.withTxn((txn) => txn.getByAuthorNonce(ADDR_1, 1n));
      const reader = await store.withTxn((txn) => txn.getByAuthorNonce(ADDR_2, 5n));
      expect(poster!.status).toBe('submitted');
      expect(reader!.status).toBe('confirmed');
    });
  });

  describe('bulk-ingest many messages in a single withTxn', () => {
    it('upsertObserved for every message in a decoded blob persists atomically', async () => {
      const store = await newStore();
      const N = 50;
      await store.withTxn(async (txn) => {
        await txn.upsertBatch(batchRow({ status: 'confirmed', blockNumber: 100 }));
        for (let i = 0; i < N; i++) {
          await txn.upsertObserved(
            messageRow({
              author: ADDR_1,
              nonce: BigInt(i + 1),
              status: 'confirmed',
              batchRef: TX_A,
              blockNumber: 100,
              txIndex: 0,
              messageIndexWithinBatch: i,
            })
          );
        }
      });
      const rows = await store.withTxn((txn) => txn.listMessages({}));
      expect(rows.length).toBe(N);
    });

    it('a throw in the middle rolls back every row (rollback-on-throw preserved)', async () => {
      const store = await newStore();
      await expect(
        store.withTxn(async (txn) => {
          await txn.upsertBatch(batchRow({ status: 'confirmed', blockNumber: 100 }));
          await txn.upsertObserved(
            messageRow({
              author: ADDR_1,
              nonce: 1n,
              status: 'confirmed',
              batchRef: TX_A,
              blockNumber: 100,
              txIndex: 0,
              messageIndexWithinBatch: 0,
            })
          );
          throw new Error('abort');
        })
      ).rejects.toThrow('abort');
      const rows = await store.withTxn((txn) => txn.listMessages({}));
      expect(rows.length).toBe(0);
      const batches = await store.withTxn((txn) => txn.listBatches({}));
      expect(batches.length).toBe(0);
    });
  });
}
