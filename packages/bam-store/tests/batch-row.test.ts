/**
 * Composite-key merge semantics for `BatchRow` after the multi-tag
 * blob-packing feature widened the primary key from `(chainId, txHash)`
 * to `(chainId, txHash, contentTag)`.
 *
 * Covers: distinct rows for same `txHash` with different `contentTag`;
 * `markReorged(txHash, …)` cascading every per-tag row in one txn; per-row
 * merge semantics (first-writer `messageSnapshot`, COALESCE on
 * `submittedAt`/`replacedByTxHash`); `getBatch` lookup; and deterministic
 * ordering from `getBatchesByTxHash`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import type { Address, Bytes32 } from 'bam-sdk';

import { PostgresBamStore } from '../src/index.js';
import type { BamStore, BatchMessageSnapshotEntry, BatchRow } from '../src/types.js';

const TAG_A = ('0x' + 'aa'.repeat(32)) as Bytes32;
const TAG_B = ('0x' + 'bb'.repeat(32)) as Bytes32;
const TAG_C = ('0x' + 'cc'.repeat(32)) as Bytes32;
const TX_A = ('0x' + '01'.repeat(32)) as Bytes32;
const ADDR_1 = ('0x' + '11'.repeat(20)) as Address;
const MID_1 = ('0x' + '99'.repeat(32)) as Bytes32;
const MHASH_1 = ('0x' + '77'.repeat(32)) as Bytes32;
const BVH = ('0x' + '03'.repeat(32)) as Bytes32;
const BCH = ('0x' + '04'.repeat(32)) as Bytes32;

function snapshotEntry(): BatchMessageSnapshotEntry {
  return {
    author: ADDR_1,
    nonce: 1n,
    messageId: MID_1,
    messageHash: MHASH_1,
    messageIndexWithinBatch: 0,
  };
}

function row(overrides: Partial<BatchRow>): BatchRow {
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
    submittedAt: null,
    invalidatedAt: null,
    submitter: null,
    l1IncludedAtUnixSec: null,
    messageSnapshot: [],
    ...overrides,
  };
}

const stores: BamStore[] = [];

async function newStore(): Promise<BamStore> {
  const db = new PGlite();
  const store = await PostgresBamStore.open(db, { cleanup: () => db.close() });
  stores.push(store);
  return store;
}

afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
});

describe('composite-key BatchRow merge semantics', () => {
  it('writes for the same (chainId, txHash) with different contentTag produce two rows', async () => {
    const store = await newStore();
    await store.withTxn(async (txn) => {
      await txn.upsertBatch(row({ contentTag: TAG_A, status: 'confirmed', blockNumber: 10 }));
      await txn.upsertBatch(row({ contentTag: TAG_B, status: 'confirmed', blockNumber: 10 }));
    });

    const all = await store.withTxn((txn) => txn.getBatchesByTxHash(1, TX_A));
    expect(all).toHaveLength(2);
    const tags = all.map((r) => r.contentTag).sort();
    expect(tags).toEqual([TAG_A, TAG_B].sort());
  });

  it('markReorged transitions every per-tag row at the txHash in one transaction', async () => {
    const store = await newStore();
    await store.withTxn(async (txn) => {
      await txn.upsertBatch(row({ contentTag: TAG_A, status: 'confirmed', blockNumber: 10 }));
      await txn.upsertBatch(row({ contentTag: TAG_B, status: 'confirmed', blockNumber: 10 }));
      await txn.upsertBatch(row({ contentTag: TAG_C, status: 'confirmed', blockNumber: 10 }));
    });

    await store.withTxn((txn) => txn.markReorged(1, TX_A, 9_001));

    const all = await store.withTxn((txn) => txn.getBatchesByTxHash(1, TX_A));
    expect(all).toHaveLength(3);
    for (const r of all) {
      expect(r.status).toBe('reorged');
      expect(r.invalidatedAt).toBe(9_001);
    }
  });

  it('preserves first-writer messageSnapshot per row on a second writer with empty snapshot', async () => {
    const store = await newStore();
    const snap = [snapshotEntry()];
    await store.withTxn(async (txn) => {
      await txn.upsertBatch(
        row({ contentTag: TAG_A, status: 'confirmed', blockNumber: 10, messageSnapshot: snap })
      );
    });
    // Second writer with empty snapshot must not clobber.
    await store.withTxn((txn) =>
      txn.upsertBatch(row({ contentTag: TAG_A, status: 'confirmed', blockNumber: 10, messageSnapshot: [] }))
    );
    const back = await store.withTxn((txn) => txn.getBatch(1, TX_A, TAG_A));
    expect(back!.messageSnapshot).toHaveLength(1);
    expect(back!.messageSnapshot[0]!.messageId).toBe(MID_1);
  });

  it('COALESCEs submittedAt and replacedByTxHash so a null second-writer does not clobber', async () => {
    const store = await newStore();
    await store.withTxn((txn) =>
      txn.upsertBatch(
        row({
          contentTag: TAG_A,
          status: 'reorged',
          blockNumber: 10,
          submittedAt: 1_234,
          replacedByTxHash: ('0x' + '02'.repeat(32)) as Bytes32,
        })
      )
    );
    await store.withTxn((txn) =>
      txn.upsertBatch(
        row({
          contentTag: TAG_A,
          status: 'reorged',
          blockNumber: 10,
          submittedAt: null,
          replacedByTxHash: null,
        })
      )
    );
    const back = await store.withTxn((txn) => txn.getBatch(1, TX_A, TAG_A));
    expect(back!.submittedAt).toBe(1_234);
    expect(back!.replacedByTxHash).toBe(('0x' + '02'.repeat(32)) as Bytes32);
  });

  it('getBatch returns null for an unknown contentTag and the row for a known tag', async () => {
    const store = await newStore();
    await store.withTxn((txn) =>
      txn.upsertBatch(row({ contentTag: TAG_A, status: 'confirmed', blockNumber: 10 }))
    );
    const known = await store.withTxn((txn) => txn.getBatch(1, TX_A, TAG_A));
    expect(known).not.toBeNull();
    expect(known!.contentTag).toBe(TAG_A);

    const unknown = await store.withTxn((txn) => txn.getBatch(1, TX_A, TAG_B));
    expect(unknown).toBeNull();
  });

  it('getBatchesByTxHash returns rows in deterministic order (by contentTag asc)', async () => {
    const store = await newStore();
    // Insert in arbitrary order; expect deterministic ordering on read.
    await store.withTxn(async (txn) => {
      await txn.upsertBatch(row({ contentTag: TAG_C, status: 'confirmed', blockNumber: 10 }));
      await txn.upsertBatch(row({ contentTag: TAG_A, status: 'confirmed', blockNumber: 10 }));
      await txn.upsertBatch(row({ contentTag: TAG_B, status: 'confirmed', blockNumber: 10 }));
    });
    const all = await store.withTxn((txn) => txn.getBatchesByTxHash(1, TX_A));
    const tags = all.map((r) => r.contentTag);
    expect(tags).toEqual([...tags].sort());
  });
});
