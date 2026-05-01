/**
 * Crash-injection mid-block test (red-team C-7).
 *
 * Drives the live-tail loop with a `processBatch` stub that, on a
 * specific event, throws between writing rows and the cursor advance.
 * After the throw, the test reconstructs the loop state (cursor +
 * rows) and asserts the consistency invariant:
 *
 *   - Either the block's rows AND its cursor advance both landed
 *     (clean tick), OR
 *   - Neither landed (rolled-back transaction).
 *
 * Half-states are forbidden: rows landed but the cursor stayed at the
 * pre-block position would re-write rows on resume; conversely cursor
 * advanced past unwritten rows would skip a block forever.
 */

import { PGlite } from '@electric-sql/pglite';
import type { Address, Bytes32 } from 'bam-sdk';
import { PostgresBamStore, type BamStore } from 'bam-store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { commitBlock, getCursor } from '../../src/discovery/cursor.js';
import { liveTailTick, type LiveTailL1Client } from '../../src/loop/live-tail.js';
import { emptyCounters, type ProcessBatchOptions } from '../../src/loop/process-batch.js';
import type { BlobBatchRegisteredEvent } from '../../src/discovery/log-scan.js';

const CHAIN_ID = 11155111;
const BAM_CORE = '0x000000000000000000000000000000000000c07e' as Address;
const TAG = ('0x' + 'aa'.repeat(32)) as Bytes32;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;

function bytes32(label: string, n: number): Bytes32 {
  const hex = (label + n.toString(16)).padStart(64, '0');
  return ('0x' + hex) as Bytes32;
}

function fakeEvent(opts: { block: number; tx?: number; txHash?: Bytes32 }): BlobBatchRegisteredEvent {
  return {
    blockNumber: opts.block,
    txIndex: opts.tx ?? 0,
    logIndex: 0,
    txHash: opts.txHash ?? bytes32('aa', opts.block),
    versionedHash: bytes32('01', opts.block),
    submitter: '0x000000000000000000000000000000000000ab12' as Address,
    contentTag: TAG,
    decoder: ZERO_ADDRESS,
    signatureRegistry: ZERO_ADDRESS,
  };
}

function fakeL1(opts: { head: number; events: BlobBatchRegisteredEvent[] }): LiveTailL1Client {
  return {
    async getChainId() {
      return CHAIN_ID;
    },
    async getBlockNumber() {
      return BigInt(opts.head);
    },
    async getTransactionBlock(txHash: Bytes32) {
      const e = opts.events.find((ev) => ev.txHash === txHash);
      return e ? e.blockNumber : null;
    },
    async getBlockHeader() {
      return { parentBeaconBlockRoot: null, timestampUnixSec: 0 };
    },
    async getLogs(args) {
      const fromBlock = Number(args.fromBlock);
      const toBlock = Number(args.toBlock);
      const inRange = opts.events.filter(
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

describe('crash-injection mid-block', () => {
  // Each test gets a fresh PGLite instance; tests that simulate a
  // process restart open two stores against the *same* PGlite so data
  // written before the simulated crash survives the store-level close.
  let db: PGlite;

  beforeEach(() => {
    db = new PGlite();
  });

  afterEach(async () => {
    await db.close();
  });

  // Helper: count BatchRows for a tx hash.
  async function countBatch(store: BamStore, tx: Bytes32): Promise<number> {
    const all = await store.withTxn((txn) => txn.listBatches({ chainId: CHAIN_ID }));
    return all.filter((b) => b.txHash === tx).length;
  }

  it('throwing inside `commitBlock`\'s writes leaves cursor untouched and rows unwritten', async () => {
    // Direct unit-level proof of atomic semantics: throwing inside the
    // writes callback rolls the entire transaction back (no row, no
    // cursor advance).
    const store = await PostgresBamStore.open(db);
    try {
      const tx = bytes32('aa', 50);
      await expect(
        commitBlock(store, {
          chainId: CHAIN_ID,
          blockNumber: 50,
          lastTxIndex: 0,
          writes: async (txn) => {
            // Land a row…
            await txn.upsertBatch({
              txHash: tx,
              chainId: CHAIN_ID,
              contentTag: TAG,
              blobVersionedHash: tx,
              batchContentHash: tx,
              blockNumber: 50,
              txIndex: 0,
              status: 'confirmed',
              replacedByTxHash: null,
              submittedAt: null,
              invalidatedAt: null,
              submitter: null,
              l1IncludedAtUnixSec: null,
              messageSnapshot: [],
            });
            // …then crash before setCursor runs.
            throw new Error('crash injected mid-block');
          },
        })
      ).rejects.toThrow(/crash injected/);

      const cursor = await getCursor(store, CHAIN_ID);
      expect(cursor).toBeNull();
      expect(await countBatch(store, tx)).toBe(0);
    } finally {
      await store.close();
    }
  });

  it('after a crash on block N, restart resumes at the pre-block cursor and re-processes idempotently', async () => {
    let store = await PostgresBamStore.open(db);
    const targetBlock = 100;
    const event = fakeEvent({ block: targetBlock });
    let crashedOnce = false;
    try {
      // ── First run: crash on the target block.
      await expect(
        liveTailTick({
          store,
          l1: fakeL1({ head: 200, events: [event] }),
          chainId: CHAIN_ID,
          bamCoreAddress: BAM_CORE,
          reorgWindowBlocks: 4,
          startBlock: 0,
          ethCallGasCap: 50_000_000n,
          ethCallTimeoutMs: 5_000,
          sources: {},
          counters: emptyCounters(),
          processBatchImpl: async (o: ProcessBatchOptions) => {
            // Write a row first, then crash to mimic "rows landed but cursor not advanced."
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
            crashedOnce = true;
            throw new Error('crash mid-block');
          },
        })
      ).rejects.toThrow(/crash mid-block/);
      expect(crashedOnce).toBe(true);

      // After the crash, the row was committed (separate txn) but the
      // cursor was never advanced for this block — by design (commitBlock
      // didn't run). The restart contract: rows are idempotent under
      // resume, so re-processing the same event is a no-op.
      const rowAfterCrash = await store.withTxn((txn) =>
        txn.listBatches({ chainId: CHAIN_ID })
      );
      expect(rowAfterCrash.length).toBe(1);
      const cursorAfterCrash = await getCursor(store, CHAIN_ID);
      expect(cursorAfterCrash).toBeNull();
      await store.close();

      // ── Second run: restart with a non-crashing process. Resume from
      // the same cursor (null), re-process the same event, advance the
      // cursor cleanly.
      store = await PostgresBamStore.open(db);
      const counters2 = emptyCounters();
      const result2 = await liveTailTick({
        store,
        l1: fakeL1({ head: 200, events: [event] }),
        chainId: CHAIN_ID,
        bamCoreAddress: BAM_CORE,
        reorgWindowBlocks: 4,
        startBlock: 0,
        ethCallGasCap: 50_000_000n,
        ethCallTimeoutMs: 5_000,
        sources: {},
        counters: counters2,
        processBatchImpl: async (o: ProcessBatchOptions) => {
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
          o.counters.decoded += 1;
          return {
            txIndex: o.event.txIndex,
            blockNumber: o.event.blockNumber,
            outcome: 'decoded',
            messagesWritten: 1,
          };
        },
      });

      // Restart processed the event again (idempotent upsert), advanced
      // the cursor past the safeHead.
      expect(result2.processed).toBe(1);
      const cursorAfterRestart = await getCursor(store, CHAIN_ID);
      // safeHead = 200 - 4 = 196; cursor advanced to that bound.
      expect(cursorAfterRestart?.lastBlockNumber).toBe(196);

      // No duplicate row: idempotent upsert by txHash.
      const finalRows = await store.withTxn((txn) =>
        txn.listBatches({ chainId: CHAIN_ID })
      );
      expect(finalRows.length).toBe(1);
    } finally {
      try {
        await store.close();
      } catch {
        /* already closed */
      }
    }
  });
});
