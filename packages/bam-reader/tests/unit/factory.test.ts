import type { Address, Bytes32 } from 'bam-sdk';
import { createMemoryStore } from 'bam-store';
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
    async getParentBeaconBlockRoot() {
      return null;
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
