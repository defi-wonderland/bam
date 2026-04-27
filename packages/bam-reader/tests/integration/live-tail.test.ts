/**
 * Integration test for the live-tail loop. Drives a stubbed L1 against
 * a real (sqlite) `bam-store`, asserting:
 *   - `processBatch` is called for every scanned event.
 *   - The cursor advances exactly once per block.
 *   - Out-of-window events are not scanned.
 *   - Counters reflect what the batch processor reports.
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Address, Bytes32 } from 'bam-sdk';
import { createDbStore } from 'bam-store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  liveTailTick,
  type LiveTailL1Client,
} from '../../src/loop/live-tail.js';
import type { BlobBatchRegisteredEvent } from '../../src/discovery/log-scan.js';
import { emptyCounters } from '../../src/loop/process-batch.js';

const CHAIN_ID = 11155111;
const BAM_CORE = '0x000000000000000000000000000000000000c07e' as Address;
const TAG = ('0x' + 'aa'.repeat(32)) as Bytes32;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;

function bytes32(label: string, n: number): Bytes32 {
  const hex = (label + n.toString(16)).padStart(64, '0');
  return ('0x' + hex) as Bytes32;
}

function fakeEvent(opts: {
  block: number;
  tx?: number;
  log?: number;
  txHash?: Bytes32;
}): BlobBatchRegisteredEvent {
  return {
    blockNumber: opts.block,
    txIndex: opts.tx ?? 0,
    logIndex: opts.log ?? 0,
    txHash: opts.txHash ?? bytes32('aa', opts.block),
    versionedHash: bytes32('01', opts.block),
    submitter: '0x000000000000000000000000000000000000ab12' as Address,
    contentTag: TAG,
    decoder: ZERO_ADDRESS,
    signatureRegistry: ZERO_ADDRESS,
  };
}

function fakeL1(opts: {
  head: number;
  events: BlobBatchRegisteredEvent[];
  parentRoots?: Map<number, Bytes32>;
  chainId?: number;
}): LiveTailL1Client {
  const calls = { logs: 0, parentRoots: 0 };
  const client: LiveTailL1Client & typeof calls = Object.assign(calls, {
    async getChainId() {
      return opts.chainId ?? CHAIN_ID;
    },
    async getBlockNumber() {
      return BigInt(opts.head);
    },
    async getTransactionBlock(txHash: Bytes32) {
      // Used by the reorg watcher; pretend everything stays on chain.
      const e = opts.events.find((ev) => ev.txHash === txHash);
      return e ? e.blockNumber : null;
    },
    async getParentBeaconBlockRoot(blockNumber: number) {
      calls.parentRoots += 1;
      return opts.parentRoots?.get(blockNumber) ?? null;
    },
    async getLogs(args) {
      calls.logs += 1;
      const fromBlock = Number(args.fromBlock);
      const toBlock = Number(args.toBlock);
      return opts.events
        .filter((e) => e.blockNumber >= fromBlock && e.blockNumber <= toBlock)
        .map((e) => ({
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
    },
  });
  return client;
}

describe('liveTailTick (integration)', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `bam-reader-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  });

  afterEach(() => {
    for (const ext of ['', '-wal', '-shm']) {
      const p = dbPath + ext;
      if (existsSync(p)) rmSync(p);
    }
  });

  it('scans events in the safe range, advances cursor, and counts processed batches', async () => {
    const store = createDbStore({ sqlitePath: dbPath });
    try {
      const events = [
        fakeEvent({ block: 100, tx: 0, log: 0 }),
        fakeEvent({ block: 100, tx: 1, log: 1, txHash: bytes32('aa', 1000) }),
        fakeEvent({ block: 102, tx: 0, log: 0, txHash: bytes32('aa', 102) }),
        fakeEvent({ block: 150, tx: 0, log: 0, txHash: bytes32('aa', 150) }), // out of safe-window
      ];
      const l1 = fakeL1({ head: 130, events }); // safeHead = 130 - 32 = 98? wrong; we use reorgWindow=32 below
      // Use reorgWindowBlocks=4 so safeHead = 126, all blocks ≤ 126 are eligible.
      const counters = emptyCounters();
      const seenEvents: BlobBatchRegisteredEvent[] = [];
      const result = await liveTailTick({
        store,
        l1,
        chainId: CHAIN_ID,
        bamCoreAddress: BAM_CORE,
        reorgWindowBlocks: 4,
        startBlock: 1,
        ethCallGasCap: 50_000_000n,
        ethCallTimeoutMs: 5_000,
        sources: {},
        counters,
        processBatchImpl: async (opts) => {
          seenEvents.push(opts.event);
          opts.counters.decoded += 1;
          return {
            txIndex: opts.event.txIndex,
            blockNumber: opts.event.blockNumber,
            outcome: 'decoded',
            messagesWritten: 1,
          };
        },
      });
      expect(result.fromBlock).toBe(1);
      expect(result.toBlock).toBe(126);
      expect(result.scanned).toBe(3); // event at 150 is outside [1,126]
      expect(result.processed).toBe(3);
      expect(counters.decoded).toBe(3);
      // Cursor advanced exactly once past every processed block — final
      // value should be the safeHead.
      const cursor = await store.withTxn((txn) => txn.getCursor(CHAIN_ID));
      expect(cursor?.lastBlockNumber).toBe(126);
      // processBatch was called for the events in canonical order.
      expect(seenEvents.map((e) => [e.blockNumber, e.logIndex])).toEqual([
        [100, 0],
        [100, 1],
        [102, 0],
      ]);
    } finally {
      await store.close();
    }
  });

  it('returns immediately with no scan when fromBlock > safeHead', async () => {
    const store = createDbStore({ sqlitePath: dbPath });
    try {
      // Pre-set the cursor past the safeHead.
      await store.withTxn(async (txn) => {
        await txn.setCursor({
          chainId: CHAIN_ID,
          lastBlockNumber: 100,
          lastTxIndex: 0,
          updatedAt: 0,
        });
      });
      const counters = emptyCounters();
      const result = await liveTailTick({
        store,
        l1: fakeL1({ head: 130, events: [] }),
        chainId: CHAIN_ID,
        bamCoreAddress: BAM_CORE,
        reorgWindowBlocks: 32,
        startBlock: 1,
        ethCallGasCap: 50_000_000n,
        ethCallTimeoutMs: 5_000,
        sources: {},
        counters,
        processBatchImpl: async () => {
          throw new Error('processBatch should not be called when range is empty');
        },
      });
      expect(result.scanned).toBe(0);
      expect(result.processed).toBe(0);
    } finally {
      await store.close();
    }
  });

  it('parks the cursor at the last good block when a transient unreachable lands', async () => {
    const store = createDbStore({ sqlitePath: dbPath });
    try {
      const events = [
        fakeEvent({ block: 100, tx: 0, log: 0 }),
        fakeEvent({ block: 101, tx: 0, log: 0, txHash: bytes32('aa', 101) }),
        fakeEvent({ block: 102, tx: 0, log: 0, txHash: bytes32('aa', 102) }),
      ];
      const l1 = fakeL1({ head: 110, events });
      const counters = emptyCounters();
      const result = await liveTailTick({
        store,
        l1,
        chainId: CHAIN_ID,
        bamCoreAddress: BAM_CORE,
        reorgWindowBlocks: 4,
        startBlock: 1,
        ethCallGasCap: 50_000_000n,
        ethCallTimeoutMs: 5_000,
        sources: {},
        counters,
        processBatchImpl: async (opts) => {
          // Block 101 is unreachable; 100 decodes, 102 should never be
          // reached because the loop bails once a transient hits.
          if (opts.event.blockNumber === 101) {
            opts.counters.undecodable += 1;
            return {
              txIndex: opts.event.txIndex,
              blockNumber: opts.event.blockNumber,
              outcome: 'unreachable',
              messagesWritten: 0,
            };
          }
          opts.counters.decoded += 1;
          return {
            txIndex: opts.event.txIndex,
            blockNumber: opts.event.blockNumber,
            outcome: 'decoded',
            messagesWritten: 1,
          };
        },
      });
      // Block 100 ran, 101 ran (and reported unreachable), 102 was skipped.
      expect(result.processed).toBe(2);
      // Cursor advanced past 100, but NOT past 101 — so the next tick
      // can re-try 101 once the transient source recovers.
      const cursor = await store.withTxn((txn) => txn.getCursor(CHAIN_ID));
      expect(cursor?.lastBlockNumber).toBe(100);
    } finally {
      await store.close();
    }
  });

  it('runs the reorg watcher tick once per call', async () => {
    const store = createDbStore({ sqlitePath: dbPath });
    try {
      let watcherTicks = 0;
      const counters = emptyCounters();
      await liveTailTick({
        store,
        l1: fakeL1({ head: 100, events: [] }),
        chainId: CHAIN_ID,
        bamCoreAddress: BAM_CORE,
        reorgWindowBlocks: 32,
        startBlock: 1,
        ethCallGasCap: 50_000_000n,
        ethCallTimeoutMs: 5_000,
        sources: {},
        counters,
        reorgWatcher: {
          async tick() {
            watcherTicks += 1;
            return { reorgedCount: 0, keptCount: 0 };
          },
        },
      });
      expect(watcherTicks).toBe(1);
    } finally {
      await store.close();
    }
  });
});
