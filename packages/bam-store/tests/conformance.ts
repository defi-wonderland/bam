/**
 * Shared conformance suite — the body run against every backend.
 * T005 wires the memory backend; T006 SQLite; T007 Postgres. Each
 * adapter that passes every case here is a conforming BamStore.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { Address, Bytes32 } from 'bam-sdk';

import type {
  BamStore,
  BatchRow,
  MessageRow,
  StoreTxn,
} from '../src/types.js';

export type StoreFactory = () => BamStore | Promise<BamStore>;

const TAG_A = ('0x' + 'aa'.repeat(32)) as Bytes32;
const TAG_B = ('0x' + 'bb'.repeat(32)) as Bytes32;
const ADDR_1 = ('0x' + '11'.repeat(20)) as Address;
const ADDR_2 = ('0x' + '22'.repeat(20)) as Address;
const TX_A = ('0x' + '01'.repeat(32)) as Bytes32;
const TX_B = ('0x' + '02'.repeat(32)) as Bytes32;
const BVH = ('0x' + '03'.repeat(32)) as Bytes32;
const BCH = ('0x' + '04'.repeat(32)) as Bytes32;

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
    messageHash: ('0x' + '77'.repeat(32)) as Bytes32,
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
        messageId: ('0x' + '99'.repeat(32)) as Bytes32,
      });
      await store.withTxn(async (txn: StoreTxn) => txn.upsertBatch(batchRow({ status: 'confirmed', blockNumber: 10 })));
      await store.withTxn(async (txn) => txn.upsertObserved(row));
      await store.withTxn(async (txn) => txn.upsertObserved(row));
      const back = await store.withTxn((txn) =>
        Promise.resolve(txn.getByAuthorNonce(ADDR_1, 1n))
      );
      expect(back).not.toBeNull();
      expect(back!.status).toBe('confirmed');
    });

    it('upsert on a row whose confirmed messageHash differs rejects (caller must markDuplicate)', async () => {
      const store = await newStore();
      const first = messageRow({
        status: 'confirmed',
        messageHash: ('0x' + '11'.repeat(32)) as Bytes32,
        batchRef: TX_A,
        blockNumber: 10,
        txIndex: 0,
        messageIndexWithinBatch: 0,
      });
      await store.withTxn(async (txn) => txn.upsertBatch(batchRow({ status: 'confirmed', blockNumber: 10 })));
      await store.withTxn(async (txn) => txn.upsertObserved(first));
      const second = messageRow({
        status: 'confirmed',
        messageHash: ('0x' + '22'.repeat(32)) as Bytes32,
      });
      await expect(
        store.withTxn(async (txn) => txn.upsertObserved(second))
      ).rejects.toThrow();
    });
  });

  describe('markDuplicate — first-confirmed wins, original not mutated', () => {
    it('the already-confirmed row is untouched; the later arrival is flagged duplicate', async () => {
      const store = await newStore();
      const confirmedHash = ('0x' + '11'.repeat(32)) as Bytes32;
      await store.withTxn(async (txn) => {
        await txn.upsertBatch(batchRow({ status: 'confirmed', blockNumber: 10 }));
        await txn.upsertObserved(
          messageRow({
            status: 'confirmed',
            messageHash: confirmedHash,
            batchRef: TX_A,
            blockNumber: 10,
            txIndex: 0,
            messageIndexWithinBatch: 0,
          })
        );
      });
      // A later arrival with the same (author, nonce) but different bytes
      // — represented here as a separate pending/submitted row with a
      // distinct messageHash — gets marked as a duplicate.
      const dupHash = ('0x' + '22'.repeat(32)) as Bytes32;
      await store.withTxn(async (txn) =>
        await txn.upsertObserved(
          messageRow({
            // The same author+nonce key would collide; in the real
            // flow, the later row is inserted under a different key path
            // (a second-Poster's view) — but in this unit test we
            // simulate by placing it under (ADDR_2, 1n) purely to
            // exercise markDuplicate mechanics.
            author: ADDR_2,
            status: 'submitted',
            messageHash: dupHash,
          })
        )
      );
      await store.withTxn(async (txn) => txn.markDuplicate(dupHash));
      const back = await store.withTxn((txn) =>
        Promise.resolve(txn.getByAuthorNonce(ADDR_2, 1n))
      );
      expect(back!.status).toBe('duplicate');
      // First row is unchanged.
      const first = await store.withTxn((txn) =>
        Promise.resolve(txn.getByAuthorNonce(ADDR_1, 1n))
      );
      expect(first!.status).toBe('confirmed');
      expect(first!.messageHash).toBe(confirmedHash);
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
      await store.withTxn(async (txn) => txn.markReorged(TX_A, 5_000));
      const batches = await store.withTxn((txn) =>
        Promise.resolve(txn.listBatches({}))
      );
      expect(batches[0].status).toBe('reorged');
      expect(batches[0].invalidatedAt).toBe(5_000);
      const r1 = await store.withTxn((txn) =>
        Promise.resolve(txn.getByAuthorNonce(ADDR_1, 1n))
      );
      const r2 = await store.withTxn((txn) =>
        Promise.resolve(txn.getByAuthorNonce(ADDR_2, 1n))
      );
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
      const rows = await store.withTxn((txn) =>
        Promise.resolve(txn.listMessages({}))
      );
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
        Promise.resolve(
          txn.listMessages({
            cursor: { blockNumber: 10, txIndex: 0, messageIndexWithinBatch: 0 },
          })
        )
      );
      expect(rows.length).toBe(2);
      expect(rows[0].nonce).toBe(2n);
      expect(rows[1].nonce).toBe(3n);
    });
  });

  describe('batch status transitions', () => {
    it('pending_tx → confirmed on updateBatchStatus with block_number', async () => {
      const store = await newStore();
      await store.withTxn(async (txn) => txn.upsertBatch(batchRow({ status: 'pending_tx' })));
      await store.withTxn(async (txn) =>
        await txn.updateBatchStatus(TX_A, 'confirmed', { blockNumber: 42, txIndex: 3 })
      );
      const [b] = await store.withTxn((txn) => Promise.resolve(txn.listBatches({})));
      expect(b.status).toBe('confirmed');
      expect(b.blockNumber).toBe(42);
      expect(b.txIndex).toBe(3);
    });

    it('confirmed → reorged via updateBatchStatus with invalidatedAt', async () => {
      const store = await newStore();
      await store.withTxn(async (txn) =>
        await txn.upsertBatch(batchRow({ status: 'confirmed', blockNumber: 10 }))
      );
      await store.withTxn(async (txn) =>
        await txn.updateBatchStatus(TX_A, 'reorged', { invalidatedAt: 9_000 })
      );
      const [b] = await store.withTxn((txn) => Promise.resolve(txn.listBatches({})));
      expect(b.status).toBe('reorged');
      expect(b.invalidatedAt).toBe(9_000);
    });
  });

  describe('reader cursor get/set', () => {
    it('getCursor on a fresh chain returns null; set+get round-trips; overwrite', async () => {
      const store = await newStore();
      const miss = await store.withTxn((txn) => Promise.resolve(txn.getCursor(1)));
      expect(miss).toBeNull();
      await store.withTxn(async (txn) =>
        await txn.setCursor({ chainId: 1, lastBlockNumber: 100, lastTxIndex: 5, updatedAt: 1_000 })
      );
      const hit = await store.withTxn((txn) => Promise.resolve(txn.getCursor(1)));
      expect(hit).toEqual({ chainId: 1, lastBlockNumber: 100, lastTxIndex: 5, updatedAt: 1_000 });
      await store.withTxn(async (txn) =>
        await txn.setCursor({ chainId: 1, lastBlockNumber: 200, lastTxIndex: 0, updatedAt: 2_000 })
      );
      const updated = await store.withTxn((txn) => Promise.resolve(txn.getCursor(1)));
      expect(updated!.lastBlockNumber).toBe(200);
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
          messageHash: ('0x' + '77'.repeat(32)) as Bytes32,
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
      const poster = await store.withTxn((txn) =>
        Promise.resolve(txn.getByAuthorNonce(ADDR_1, 1n))
      );
      const reader = await store.withTxn((txn) =>
        Promise.resolve(txn.getByAuthorNonce(ADDR_2, 5n))
      );
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
      const rows = await store.withTxn((txn) => Promise.resolve(txn.listMessages({})));
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
      const rows = await store.withTxn((txn) => Promise.resolve(txn.listMessages({})));
      expect(rows.length).toBe(0);
      const batches = await store.withTxn((txn) => Promise.resolve(txn.listBatches({})));
      expect(batches.length).toBe(0);
    });
  });
}
