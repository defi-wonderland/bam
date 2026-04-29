import type { Address, Bytes32 } from 'bam-sdk';
import { createMemoryStore } from 'bam-store';
import type {
  BatchMessageSnapshotEntry,
  BatchRow,
  MessageRow,
} from 'bam-store';
import { describe, expect, it } from 'vitest';

import { ChainIdMismatch } from '../../src/errors.js';
import { createReader } from '../../src/factory.js';
import type { LiveTailL1Client } from '../../src/loop/live-tail.js';
import type { ReaderConfig } from '../../src/types.js';

const BAM_CORE = '0x000000000000000000000000000000000000c07e' as Address;

function baseConfig(): ReaderConfig {
  return {
    chainId: 11155111,
    rpcUrl: 'https://rpc.example',
    bamCoreAddress: BAM_CORE,
    reorgWindowBlocks: 32,
    dbUrl: 'memory:',
    httpBind: '127.0.0.1',
    httpPort: 8788,
    ethCallGasCap: 50_000_000n,
    ethCallTimeoutMs: 5_000,
    logScanChunkBlocks: 2_000,
    backfillProgressIntervalMs: 10_000,
    backfillProgressEveryChunks: 5,
  };
}

function fakeL1(opts: { chainId: number; head?: number }): LiveTailL1Client {
  return {
    async getChainId() {
      return opts.chainId;
    },
    async getBlockNumber() {
      return BigInt(opts.head ?? 100);
    },
    async getTransactionBlock() {
      return null;
    },
    async getBlockHeader() {
      return { parentBeaconBlockRoot: null, timestampUnixSec: 0 };
    },
    async getLogs() {
      return [];
    },
  };
}

describe('createReader', () => {
  it('throws ChainIdMismatch when the RPC reports a different chain id', async () => {
    await expect(
      createReader(baseConfig(), { l1: fakeL1({ chainId: 1 }) })
    ).rejects.toBeInstanceOf(ChainIdMismatch);
  });

  it('constructs a reader against an in-memory store with no fallback sources', async () => {
    const reader = await createReader(baseConfig(), {
      l1: fakeL1({ chainId: 11155111 }),
      store: await createMemoryStore(),
    });
    const health = await reader.health();
    expect(health.chainId).toBe(11155111);
    expect(health.cursor).toBeNull();
    expect(health.counters.decoded).toBe(0);
    await reader.close();
  });

  it('serve() returns a promise that completes once close() is called', async () => {
    const reader = await createReader(baseConfig(), {
      l1: fakeL1({ chainId: 11155111 }),
      store: await createMemoryStore(),
      livePollMs: 5,
    });
    const serving = reader.serve();
    // Yield once so the loop completes its first iteration.
    await new Promise((r) => setTimeout(r, 20));
    await reader.close();
    await serving; // resolves cleanly after close
  });

  it('runs a backfill against a stub L1 with no events', async () => {
    const reader = await createReader(baseConfig(), {
      l1: fakeL1({ chainId: 11155111, head: 100 }),
      store: await createMemoryStore(),
    });
    const result = await reader.backfill(0, 50);
    expect(result.scanned).toBe(0);
    expect(result.processed).toBe(0);
    await reader.close();
  });

  it('cursorBlock() returns null on a fresh DB and the last block after a backfill', async () => {
    const store = await createMemoryStore();
    const reader = await createReader(baseConfig(), {
      l1: fakeL1({ chainId: 11155111, head: 100 }),
      store,
    });
    expect(await reader.cursorBlock()).toBeNull();
    await reader.backfill(0, 50);
    expect(await reader.cursorBlock()).toBe(50);
    await reader.close();
    await store.close();
  });

  it('honors config.startBlock for the live-tail first tick when extras.startBlock is unset', async () => {
    // Regression guard: the factory must thread `config.startBlock` to
    // the live-tail when the caller didn't pass `extras.startBlock`.
    const calls: Array<{ from: number; to: number }> = [];
    const l1: LiveTailL1Client = {
      async getChainId() {
        return 11155111;
      },
      async getBlockNumber() {
        return 5_000n;
      },
      async getTransactionBlock() {
        return null;
      },
      async getBlockHeader() {
        return { parentBeaconBlockRoot: null, timestampUnixSec: 0 };
      },
      async getLogs(args) {
        calls.push({ from: Number(args.fromBlock), to: Number(args.toBlock) });
        return [];
      },
    };
    const store = await createMemoryStore();
    const reader = await createReader(
      { ...baseConfig(), startBlock: 1234, reorgWindowBlocks: 32 },
      { l1, store, livePollMs: 60_000 }
    );
    const serving = reader.serve();
    for (let i = 0; i < 100 && calls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await reader.close();
    await serving;
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0].from).toBe(1234);
    await store.close();
  });

  it('extras.startBlock wins over config.startBlock', async () => {
    const calls: Array<{ from: number; to: number }> = [];
    const l1: LiveTailL1Client = {
      async getChainId() {
        return 11155111;
      },
      async getBlockNumber() {
        return 5_000n;
      },
      async getTransactionBlock() {
        return null;
      },
      async getBlockHeader() {
        return { parentBeaconBlockRoot: null, timestampUnixSec: 0 };
      },
      async getLogs(args) {
        calls.push({ from: Number(args.fromBlock), to: Number(args.toBlock) });
        return [];
      },
    };
    const store = await createMemoryStore();
    const reader = await createReader(
      { ...baseConfig(), startBlock: 1234, reorgWindowBlocks: 32 },
      { l1, store, livePollMs: 60_000, startBlock: 4000 }
    );
    const serving = reader.serve();
    for (let i = 0; i < 100 && calls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await reader.close();
    await serving;
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0].from).toBe(4000);
    await store.close();
  });

  describe('read façade — pass-throughs over bam-store', () => {
    const TAG = ('0x' + 'aa'.repeat(32)) as Bytes32;
    const ADDR = ('0x' + '11'.repeat(20)) as Address;
    const TX_KNOWN = ('0x' + '01'.repeat(32)) as Bytes32;
    const TX_OTHER = ('0x' + '02'.repeat(32)) as Bytes32;
    const TX_UNKNOWN = ('0x' + 'ee'.repeat(32)) as Bytes32;
    const BVH = ('0x' + '03'.repeat(32)) as Bytes32;
    const BCH = ('0x' + '04'.repeat(32)) as Bytes32;
    const MID = ('0x' + '99'.repeat(32)) as Bytes32;
    const MHASH = ('0x' + '77'.repeat(32)) as Bytes32;

    function snapshotEntry(): BatchMessageSnapshotEntry {
      return {
        author: ADDR,
        nonce: 1n,
        messageId: MID,
        messageHash: MHASH,
        messageIndexWithinBatch: 0,
      };
    }
    function batchRow(over: Partial<BatchRow> = {}): BatchRow {
      return {
        txHash: TX_KNOWN,
        chainId: 11155111,
        contentTag: TAG,
        blobVersionedHash: BVH,
        batchContentHash: BCH,
        blockNumber: 10,
        txIndex: 0,
        status: 'confirmed',
        replacedByTxHash: null,
        submittedAt: 1_000,
        invalidatedAt: null,
        submitter: null,
        l1IncludedAtUnixSec: null,
        messageSnapshot: [snapshotEntry()],
        ...over,
      };
    }
    function messageRow(over: Partial<MessageRow> = {}): MessageRow {
      return {
        messageId: MID,
        author: ADDR,
        nonce: 1n,
        contentTag: TAG,
        contents: new Uint8Array([1, 2, 3]),
        signature: new Uint8Array(65),
        messageHash: MHASH,
        status: 'confirmed',
        batchRef: TX_KNOWN,
        ingestedAt: null,
        ingestSeq: null,
        blockNumber: 10,
        txIndex: 0,
        messageIndexWithinBatch: 0,
        ...over,
      };
    }

    async function seed() {
      const store = await createMemoryStore();
      await store.withTxn(async (txn) => {
        await txn.upsertBatch(batchRow());
        await txn.upsertBatch(batchRow({ txHash: TX_OTHER, blockNumber: 11 }));
        await txn.upsertObserved(messageRow());
      });
      return store;
    }

    it('listConfirmedMessages returns the seeded confirmed rows', async () => {
      const store = await seed();
      const reader = await createReader(baseConfig(), {
        l1: fakeL1({ chainId: 11155111 }),
        store,
      });
      const rows = await reader.listConfirmedMessages({
        contentTag: TAG,
        status: 'confirmed',
      });
      expect(rows.length).toBe(1);
      expect(rows[0].author.toLowerCase()).toBe(ADDR.toLowerCase());
      expect(rows[0].nonce).toBe(1n);
      await reader.close();
    });

    it('listBatches returns the seeded batches', async () => {
      const store = await seed();
      const reader = await createReader(baseConfig(), {
        l1: fakeL1({ chainId: 11155111 }),
        store,
      });
      const rows = await reader.listBatches({
        contentTag: TAG,
        status: 'confirmed',
      });
      expect(rows.length).toBe(2);
      const hashes = rows.map((r) => r.txHash).sort();
      expect(hashes).toEqual([TX_KNOWN, TX_OTHER].sort());
      await reader.close();
    });

    it('getBatch returns a row for a known hash and null for an unknown one', async () => {
      const store = await seed();
      const reader = await createReader(baseConfig(), {
        l1: fakeL1({ chainId: 11155111 }),
        store,
      });
      const hit = await reader.getBatch(TX_KNOWN);
      expect(hit).not.toBeNull();
      expect(hit!.txHash).toBe(TX_KNOWN);
      expect(hit!.messageSnapshot.length).toBe(1);

      const miss = await reader.getBatch(TX_UNKNOWN);
      expect(miss).toBeNull();
      await reader.close();
    });
  });

  it('reports blocksBehindHead from cursor + l1 head in health()', async () => {
    const store = await createMemoryStore();
    await store.withTxn(async (txn) => {
      await txn.setCursor({
        chainId: 11155111,
        lastBlockNumber: 90,
        lastTxIndex: 0,
        updatedAt: 42,
      });
    });
    const reader = await createReader(baseConfig(), {
      l1: fakeL1({ chainId: 11155111, head: 100 }),
      store,
    });
    const health = await reader.health();
    expect(health.cursor?.lastBlockNumber).toBe(90);
    expect(health.blocksBehindHead).toBe(10);
    await reader.close();
  });
});
