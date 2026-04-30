/**
 * Reorg watcher atomicity for a packed transaction (T017, C-3).
 *
 * Setup: write N `confirmed` `BatchRow`s under the same `txHash` (one
 * per `contentTag`, simulating a packed `registerBlobBatches`
 * transaction). Drive the Reader's reorg watcher with a stubbed
 * `BlockSource` that returns `null` for the packed `txHash` (it has
 * reorged out).
 *
 * Assertions:
 *   - After `tick()`, all N rows transitioned to `reorged` together
 *     (the same `markReorged(txHash, …)` call updates every per-tag
 *     row in one store txn — composite-key world from T007/T008).
 *   - `invalidatedAt` is identical across all rows (single `now()` per
 *     markReorged call).
 *   - The watcher reports `reorgedCount` matching the number of
 *     candidate rows it iterated.
 */

import type { Address, Bytes32 } from 'bam-sdk';
import { createMemoryStore } from 'bam-store';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ReaderReorgWatcher,
  type BlockSource,
} from '../../src/reorg-watcher.js';

const CHAIN_ID = 11155111;
const PACKED_TX = ('0x' + 'cc'.repeat(32)) as Bytes32;
const PACKED_BLOCK = 100;
const TAGS: Bytes32[] = [
  ('0x' + 'a1'.repeat(32)) as Bytes32,
  ('0x' + 'a2'.repeat(32)) as Bytes32,
  ('0x' + 'a3'.repeat(32)) as Bytes32,
  ('0x' + 'a4'.repeat(32)) as Bytes32,
];

const stores: Awaited<ReturnType<typeof createMemoryStore>>[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
});

describe('reorg watcher atomicity for packed tx (T017)', () => {
  it('all N per-tag rows for one packed txHash transition to reorged together', async () => {
    const store = await createMemoryStore();
    stores.push(store);

    // Write N confirmed BatchRows under the same packed txHash.
    await store.withTxn(async (txn) => {
      for (const tag of TAGS) {
        await txn.upsertBatch({
          txHash: PACKED_TX,
          chainId: CHAIN_ID,
          contentTag: tag,
          blobVersionedHash: PACKED_TX,
          batchContentHash: PACKED_TX,
          blockNumber: PACKED_BLOCK,
          txIndex: 0,
          status: 'confirmed',
          replacedByTxHash: null,
          submittedAt: null,
          invalidatedAt: null,
          submitter: ('0x' + '00'.repeat(20)) as Address,
          l1IncludedAtUnixSec: null,
          messageSnapshot: [],
        });
      }
    });

    // BlockSource: packed tx is gone from the canonical chain.
    const blockSource: BlockSource = {
      async getBlockNumber() {
        return BigInt(PACKED_BLOCK + 1);
      },
      async getTransactionBlock(txHash: Bytes32) {
        return txHash === PACKED_TX ? null : PACKED_BLOCK;
      },
    };

    const watcher = new ReaderReorgWatcher({
      store,
      blockSource,
      chainId: CHAIN_ID,
      reorgWindowBlocks: 4,
      now: () => new Date(7_777_000),
    });

    const result = await watcher.tick();

    // Every candidate row was marked reorged. The watcher's per-batch
    // loop calls `markReorged(txHash, …)` once per candidate; each call
    // is itself a single store txn that updates every per-tag row at
    // the txHash to `reorged` (composite-key widening). Subsequent
    // calls for the same txHash are idempotent.
    expect(result.reorgedCount).toBe(TAGS.length);
    expect(result.keptCount).toBe(0);

    // All rows now `reorged` with the same `invalidatedAt`.
    const rows = await store.withTxn((txn) =>
      txn.getBatchesByTxHash(CHAIN_ID, PACKED_TX)
    );
    expect(rows).toHaveLength(TAGS.length);
    for (const r of rows) {
      expect(r.status).toBe('reorged');
      expect(r.invalidatedAt).toBe(7_777_000);
    }
  });

  it('single markReorged call inside one withTxn flips every per-tag row atomically', async () => {
    // Direct exercise of the substrate guarantee: a single markReorged
    // call updates every row at the txHash in one transaction. No
    // half-state is observable from a concurrent reader.
    const store = await createMemoryStore();
    stores.push(store);

    await store.withTxn(async (txn) => {
      for (const tag of TAGS) {
        await txn.upsertBatch({
          txHash: PACKED_TX,
          chainId: CHAIN_ID,
          contentTag: tag,
          blobVersionedHash: PACKED_TX,
          batchContentHash: PACKED_TX,
          blockNumber: PACKED_BLOCK,
          txIndex: 0,
          status: 'confirmed',
          replacedByTxHash: null,
          submittedAt: null,
          invalidatedAt: null,
          submitter: ('0x' + '00'.repeat(20)) as Address,
          l1IncludedAtUnixSec: null,
          messageSnapshot: [],
        });
      }
    });

    await store.withTxn(async (txn) => {
      await txn.markReorged(CHAIN_ID, PACKED_TX, 9_001);
    });

    const rows = await store.withTxn((txn) =>
      txn.getBatchesByTxHash(CHAIN_ID, PACKED_TX)
    );
    expect(rows).toHaveLength(TAGS.length);
    for (const r of rows) {
      expect(r.status).toBe('reorged');
      expect(r.invalidatedAt).toBe(9_001);
    }
  });
});
