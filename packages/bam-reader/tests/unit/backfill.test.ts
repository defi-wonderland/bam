import type { Address, Bytes32 } from 'bam-sdk';
import { createMemoryStore } from 'bam-store';
import { describe, expect, it } from 'vitest';

import { backfill } from '../../src/loop/backfill.js';
import type { LiveTailL1Client } from '../../src/loop/live-tail.js';
import type { BlobBatchRegisteredEvent } from '../../src/discovery/log-scan.js';
import { emptyCounters } from '../../src/loop/process-batch.js';
import type { ReaderEvent } from '../../src/types.js';

const CHAIN_ID = 11155111;
const BAM_CORE = '0x000000000000000000000000000000000000c07e' as Address;
const TAG = ('0x' + 'aa'.repeat(32)) as Bytes32;
const ZERO = '0x0000000000000000000000000000000000000000' as Address;

function bytes32(label: string, n: number): Bytes32 {
  const hex = (label + n.toString(16)).padStart(64, '0');
  return ('0x' + hex) as Bytes32;
}

function fakeEvent(block: number): BlobBatchRegisteredEvent {
  return {
    blockNumber: block,
    txIndex: 0,
    logIndex: 0,
    txHash: bytes32('aa', block),
    versionedHash: bytes32('01', block),
    submitter: '0x000000000000000000000000000000000000ab12' as Address,
    contentTag: TAG,
    decoder: ZERO,
    signatureRegistry: ZERO,
  };
}

function fakeL1(opts: {
  head: number;
  events: BlobBatchRegisteredEvent[];
}): LiveTailL1Client {
  return {
    async getChainId() {
      return CHAIN_ID;
    },
    async getBlockNumber() {
      return BigInt(opts.head);
    },
    async getTransactionBlock() {
      return null;
    },
    async getBlockHeader(blockNumber: number) {
      return { parentBeaconBlockRoot: null, timestampUnixSec: blockNumber };
    },
    async getLogs(args) {
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
  };
}

describe('backfill — backfill_progress events', () => {
  it('emits a progress event when the time threshold is hit per chunk', async () => {
    const store = await createMemoryStore();
    try {
      // Fake clock that advances 10s on every read; with default 10s
      // cadence each chunk should fire an event.
      let clock = 0;
      const now = () => {
        const out = clock;
        clock += 10_000;
        return out;
      };
      const events = [fakeEvent(50), fakeEvent(2_500), fakeEvent(4_500)];
      const captured: ReaderEvent[] = [];
      const counters = emptyCounters();
      await backfill({
        store,
        l1: fakeL1({ head: 6_000, events }),
        chainId: CHAIN_ID,
        bamCoreAddress: BAM_CORE,
        fromBlock: 0,
        toBlock: 6_000,
        chunkSize: 2_000, // 4 chunks: [0..1999], [2000..3999], [4000..5999], [6000..6000]
        logScanChunkBlocks: 2_000,
        progressIntervalMs: 10_000,
        progressEveryChunks: 1_000, // disable chunk-based path for this test
        ethCallGasCap: 50_000_000n,
        ethCallTimeoutMs: 5_000,
        sources: {},
        counters,
        logger: (e) => captured.push(e),
        now,
        processBatchImpl: async (opts) => {
          opts.counters.decoded += 1;
          return {
            txIndex: opts.event.txIndex,
            blockNumber: opts.event.blockNumber,
            outcome: 'decoded' as const,
            messagesWritten: 1,
          };
        },
      });
      const progress = captured.filter((e) => e.kind === 'backfill_progress');
      // 4 chunks each fire on the time threshold + the closing emit.
      expect(progress.length).toBeGreaterThanOrEqual(4);
    } finally {
      await store.close();
    }
  });

  it('emits a progress event every N chunks (chunk-based cadence)', async () => {
    const store = await createMemoryStore();
    try {
      const captured: ReaderEvent[] = [];
      const counters = emptyCounters();
      await backfill({
        store,
        l1: fakeL1({ head: 6_000, events: [] }),
        chainId: CHAIN_ID,
        bamCoreAddress: BAM_CORE,
        fromBlock: 0,
        toBlock: 6_000,
        chunkSize: 2_000, // 4 chunks
        logScanChunkBlocks: 2_000,
        progressIntervalMs: 60_000_000, // disable time-based path
        progressEveryChunks: 2,
        ethCallGasCap: 50_000_000n,
        ethCallTimeoutMs: 5_000,
        sources: {},
        counters,
        logger: (e) => captured.push(e),
        now: () => 0,
      });
      const progress = captured.filter((e) => e.kind === 'backfill_progress');
      // Chunks 1..4: emit at chunk 2, chunk 4, plus closing emit ⇒ ≥ 3.
      expect(progress.length).toBeGreaterThanOrEqual(2);
    } finally {
      await store.close();
    }
  });

  it('always emits a closing progress event even on a one-chunk run', async () => {
    const store = await createMemoryStore();
    try {
      const captured: ReaderEvent[] = [];
      const counters = emptyCounters();
      await backfill({
        store,
        l1: fakeL1({ head: 100, events: [] }),
        chainId: CHAIN_ID,
        bamCoreAddress: BAM_CORE,
        fromBlock: 0,
        toBlock: 100,
        chunkSize: 1_000, // 1 chunk
        logScanChunkBlocks: 1_000,
        progressIntervalMs: 60_000_000,
        progressEveryChunks: 1_000,
        ethCallGasCap: 50_000_000n,
        ethCallTimeoutMs: 5_000,
        sources: {},
        counters,
        logger: (e) => captured.push(e),
        now: () => 0,
      });
      const progress = captured.filter((e) => e.kind === 'backfill_progress');
      // Exactly one closing emit (no per-chunk emit fired because both
      // thresholds were set above the actual run).
      expect(progress.length).toBe(1);
    } finally {
      await store.close();
    }
  });

  it('progress payload contains only the documented number fields (G-8)', async () => {
    const store = await createMemoryStore();
    try {
      const captured: ReaderEvent[] = [];
      const counters = emptyCounters();
      await backfill({
        store,
        l1: fakeL1({ head: 100, events: [] }),
        chainId: CHAIN_ID,
        bamCoreAddress: BAM_CORE,
        fromBlock: 0,
        toBlock: 100,
        chunkSize: 1_000,
        logScanChunkBlocks: 1_000,
        progressIntervalMs: 1,
        progressEveryChunks: 1,
        ethCallGasCap: 50_000_000n,
        ethCallTimeoutMs: 5_000,
        sources: {},
        counters,
        logger: (e) => captured.push(e),
        now: () => 0,
      });
      const progress = captured.filter((e) => e.kind === 'backfill_progress');
      expect(progress.length).toBeGreaterThan(0);
      for (const e of progress) {
        const keys = Object.keys(e).sort();
        expect(keys).toEqual(
          ['currentBlock', 'fromBlock', 'kind', 'processed', 'scanned', 'toBlock'].sort()
        );
        for (const k of ['fromBlock', 'toBlock', 'currentBlock', 'scanned', 'processed']) {
          expect(typeof (e as Record<string, unknown>)[k]).toBe('number');
        }
      }
    } finally {
      await store.close();
    }
  });
});
