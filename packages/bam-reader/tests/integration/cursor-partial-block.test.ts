/**
 * Cursor advancement contract for packed transactions (T016, C-4).
 *
 * Stubs an L1 emitting a packed tx with N `BlobBatchRegistered` events
 * in a single block (one tx hash, N distinct contentTags). The Reader's
 * processBatchImpl is patched to throw after writing K of N rows. The
 * test then asserts:
 *
 *   - Restart with no crash injection re-processes the *same* block.
 *   - All N rows are present (no duplicates: composite-key idempotency
 *     from T007/T008 makes the resume a no-op for already-landed rows).
 *   - The cursor is at the expected block after restart.
 *
 * The crash injection happens *between* per-batch writes; idempotency
 * carries the "row landed before the crash" rows across the restart
 * without producing duplicates.
 */

import { PGlite } from '@electric-sql/pglite';
import type { Address, Bytes32 } from 'bam-sdk';
import { PostgresBamStore, type BamStore } from 'bam-store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getCursor } from '../../src/discovery/cursor.js';
import { liveTailTick, type LiveTailL1Client } from '../../src/loop/live-tail.js';
import {
  emptyCounters,
  type ProcessBatchOptions,
} from '../../src/loop/process-batch.js';
import type { BlobBatchRegisteredEvent } from '../../src/discovery/log-scan.js';

const CHAIN_ID = 11155111;
const BAM_CORE = '0x000000000000000000000000000000000000c07e' as Address;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;
const TAGS: Bytes32[] = [
  ('0x' + 'a1'.repeat(32)) as Bytes32,
  ('0x' + 'a2'.repeat(32)) as Bytes32,
  ('0x' + 'a3'.repeat(32)) as Bytes32,
  ('0x' + 'a4'.repeat(32)) as Bytes32,
  ('0x' + 'a5'.repeat(32)) as Bytes32,
];

const PACKED_TX = ('0x' + 'cc'.repeat(32)) as Bytes32;
const VERSIONED_HASH = ('0x' + '01' + '00'.repeat(31)) as Bytes32;
const PACKED_BLOCK = 100;

function packedEvent(idx: number): BlobBatchRegisteredEvent {
  return {
    blockNumber: PACKED_BLOCK,
    txIndex: 0,
    logIndex: idx,
    txHash: PACKED_TX,
    versionedHash: VERSIONED_HASH,
    submitter: '0x000000000000000000000000000000000000ab12' as Address,
    contentTag: TAGS[idx]!,
    decoder: ZERO_ADDRESS,
    signatureRegistry: ZERO_ADDRESS,
  };
}

const PACKED_EVENTS = TAGS.map((_, i) => packedEvent(i));

function fakeL1(head: number, events: BlobBatchRegisteredEvent[]): LiveTailL1Client {
  return {
    async getChainId() {
      return CHAIN_ID;
    },
    async getBlockNumber() {
      return BigInt(head);
    },
    async getTransactionBlock(txHash: Bytes32) {
      const e = events.find((ev) => ev.txHash === txHash);
      return e ? e.blockNumber : null;
    },
    async getBlockHeader() {
      return { parentBeaconBlockRoot: null, timestampUnixSec: 0 };
    },
    async getLogs(args) {
      const fromBlock = Number(args.fromBlock);
      const toBlock = Number(args.toBlock);
      const inRange = events.filter(
        (e) => e.blockNumber >= fromBlock && e.blockNumber <= toBlock
      );
      const batchOut = inRange.map((e) => ({
        eventName: 'BlobBatchRegistered' as const,
        blockNumber: BigInt(e.blockNumber),
        transactionIndex: BigInt(e.txIndex),
        logIndex: BigInt(e.logIndex),
        transactionHash: e.txHash,
        args: {
          versionedHash: e.versionedHash,
          submitter: e.submitter,
          contentTag: e.contentTag,
          decoder: e.decoder,
          signatureRegistry: e.signatureRegistry,
        },
      }));
      const segmentOut = inRange.map((e) => ({
        eventName: 'BlobSegmentDeclared' as const,
        blockNumber: BigInt(e.blockNumber),
        transactionIndex: BigInt(e.txIndex),
        logIndex: BigInt(Math.max(0, e.logIndex - 1)),
        transactionHash: e.txHash,
        args: {
          versionedHash: e.versionedHash,
          declarer: e.submitter,
          startFE: e.startFE ?? 0,
          endFE: e.endFE ?? 4096,
          contentTag: e.contentTag,
        },
      }));
      return [...batchOut, ...segmentOut];
    },
  };
}

async function writeBatch(o: ProcessBatchOptions): Promise<void> {
  await o.store.withTxn(async (txn) => {
    await txn.upsertBatch({
      txHash: o.event.txHash,
      chainId: o.chainId,
      contentTag: o.event.contentTag,
      blobVersionedHash: o.event.versionedHash,
      batchContentHash: o.event.versionedHash,
      blockNumber: o.event.blockNumber,
      txIndex: o.event.txIndex,
      status: 'confirmed',
      replacedByTxHash: null,
      submittedAt: null,
      invalidatedAt: null,
      submitter: null,
      l1IncludedAtUnixSec: null,
      messageSnapshot: [],
    });
  });
}

describe('cursor advancement under packed-tx mid-block crash (T016)', () => {
  let db: PGlite;
  beforeEach(() => {
    db = new PGlite();
  });
  afterEach(async () => {
    await db.close();
  });

  it('crashing after K of N writes leaves cursor pre-block; restart converges to N rows + advanced cursor', async () => {
    const N = TAGS.length;
    const KILL_AFTER = 3;

    // ── First run: crash after K=3 of N=5 batches.
    let store = await PostgresBamStore.open(db);
    let processed = 0;
    await expect(
      liveTailTick({
        store,
        l1: fakeL1(200, PACKED_EVENTS),
        chainId: CHAIN_ID,
        bamCoreAddress: BAM_CORE,
        reorgWindowBlocks: 4,
        startBlock: 0,
        logScanChunkBlocks: 2_000,
        ethCallGasCap: 50_000_000n,
        ethCallTimeoutMs: 5_000,
        sources: {},
        counters: emptyCounters(),
        processBatchImpl: async (o: ProcessBatchOptions) => {
          await writeBatch(o);
          processed += 1;
          if (processed === KILL_AFTER) {
            throw new Error('crash mid-block after K of N events');
          }
          o.counters.decoded += 1;
          return {
            txIndex: o.event.txIndex,
            blockNumber: o.event.blockNumber,
            outcome: 'decoded',
            messagesWritten: 0,
          };
        },
      })
    ).rejects.toThrow(/crash mid-block/);

    // After the crash: K rows landed (their per-batch txns committed),
    // but the cursor never advanced (commitBlock never ran).
    const rowsAfterCrash = await store.withTxn((txn) =>
      txn.getBatchesByTxHash(CHAIN_ID, PACKED_TX)
    );
    expect(rowsAfterCrash.length).toBe(KILL_AFTER);
    expect(await getCursor(store, CHAIN_ID)).toBeNull();
    await store.close();

    // ── Second run: restart against the same PGLite. Re-scan from the
    // same starting cursor, re-process every packed event idempotently
    // (composite key + COALESCE/first-writer merge from T007/T008),
    // and commit the cursor cleanly.
    store = await PostgresBamStore.open(db);
    try {
      const counters = emptyCounters();
      const result = await liveTailTick({
        store,
        l1: fakeL1(200, PACKED_EVENTS),
        chainId: CHAIN_ID,
        bamCoreAddress: BAM_CORE,
        reorgWindowBlocks: 4,
        startBlock: 0,
        logScanChunkBlocks: 2_000,
        ethCallGasCap: 50_000_000n,
        ethCallTimeoutMs: 5_000,
        sources: {},
        counters,
        processBatchImpl: async (o: ProcessBatchOptions) => {
          await writeBatch(o);
          o.counters.decoded += 1;
          return {
            txIndex: o.event.txIndex,
            blockNumber: o.event.blockNumber,
            outcome: 'decoded',
            messagesWritten: 0,
          };
        },
      });

      // All N rows are present after restart — no duplicates (we
      // re-processed K previously-landed events but composite-key
      // upsert is idempotent), no missing rows.
      const allRows = await store.withTxn((txn) =>
        txn.getBatchesByTxHash(CHAIN_ID, PACKED_TX)
      );
      expect(allRows.length).toBe(N);
      const tags = new Set(allRows.map((r) => r.contentTag));
      expect(tags.size).toBe(N);

      // Cursor is now at the packed-tx block, all events committed.
      const cursor = await getCursor(store, CHAIN_ID);
      expect(cursor?.lastBlockNumber).toBeGreaterThanOrEqual(PACKED_BLOCK);

      // Counters: K events were processed (and counted) in the first
      // run before the crash; the restart re-processed all N. So the
      // restart's counter should be N.
      expect(counters.decoded).toBe(N);
      expect(result.processed).toBe(N);
    } finally {
      await store.close();
    }
  });
});
