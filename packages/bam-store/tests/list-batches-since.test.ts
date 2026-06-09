/**
 * `BatchesQuery.sinceIncludedAtUnixSec` — inclusive lower bound on
 * `l1IncludedAtUnixSec`. Batches with a NULL inclusion time (rare,
 * pre-Reader-fill artifacts) are excluded when the filter is set.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import type { Address, Bytes32 } from 'bam-sdk';

import { PostgresBamStore } from '../src/index.js';
import type { BamStore, BatchRow } from '../src/types.js';

const TAG = ('0x' + 'aa'.repeat(32)) as Bytes32;
const TX_A = ('0x' + '01'.repeat(32)) as Bytes32;
const TX_B = ('0x' + '02'.repeat(32)) as Bytes32;
const TX_C = ('0x' + '03'.repeat(32)) as Bytes32;
const BVH = ('0x' + '0b'.repeat(32)) as Bytes32;
const BCH = ('0x' + '0c'.repeat(32)) as Bytes32;
const SUBMITTER = ('0x' + '44'.repeat(20)) as Address;

function row(overrides: Partial<BatchRow>): BatchRow {
  return {
    txHash: TX_A,
    chainId: 1,
    contentTag: TAG,
    blobVersionedHash: BVH,
    batchContentHash: BCH,
    blockNumber: 100,
    txIndex: 0,
    status: 'confirmed',
    replacedByTxHash: null,
    submittedAt: null,
    invalidatedAt: null,
    submitter: SUBMITTER,
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

describe('listBatches sinceIncludedAtUnixSec filter', () => {
  async function seedThree(store: BamStore): Promise<void> {
    await store.withTxn(async (txn) => {
      await txn.upsertBatch(row({ txHash: TX_A, blockNumber: 10, l1IncludedAtUnixSec: 1000 }));
      await txn.upsertBatch(row({ txHash: TX_B, blockNumber: 11, l1IncludedAtUnixSec: 2000 }));
      await txn.upsertBatch(row({ txHash: TX_C, blockNumber: 12, l1IncludedAtUnixSec: null }));
    });
  }

  it('without the filter returns all three rows (including the null-timestamp row)', async () => {
    const store = await newStore();
    await seedThree(store);
    const all = await store.withTxn((txn) => txn.listBatches({ contentTag: TAG }));
    expect(all).toHaveLength(3);
  });

  it('with sinceIncludedAtUnixSec=1500 returns only the row at 2000 (null row excluded)', async () => {
    const store = await newStore();
    await seedThree(store);
    const rows = await store.withTxn((txn) =>
      txn.listBatches({ contentTag: TAG, sinceIncludedAtUnixSec: 1500n })
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.txHash).toBe(TX_B);
    expect(rows[0]!.l1IncludedAtUnixSec).toBe(2000);
  });

  it('treats the boundary as inclusive (sinceIncludedAtUnixSec=2000 returns the 2000 row)', async () => {
    const store = await newStore();
    await seedThree(store);
    const rows = await store.withTxn((txn) =>
      txn.listBatches({ contentTag: TAG, sinceIncludedAtUnixSec: 2000n })
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.txHash).toBe(TX_B);
  });

  it('returns no rows when the floor exceeds every non-null timestamp', async () => {
    const store = await newStore();
    await seedThree(store);
    const rows = await store.withTxn((txn) =>
      txn.listBatches({ contentTag: TAG, sinceIncludedAtUnixSec: 2001n })
    );
    expect(rows).toEqual([]);
  });
});
