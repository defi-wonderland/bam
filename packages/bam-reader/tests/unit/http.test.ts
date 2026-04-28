import type { Address } from 'bam-sdk';
import { createMemoryStore } from 'bam-store';
import { afterEach, describe, expect, it } from 'vitest';

import { createReader } from '../../src/factory.js';
import { ReaderHttpServer } from '../../src/http/server.js';
import type { LiveTailL1Client } from '../../src/loop/live-tail.js';
import type { ReaderConfig } from '../../src/types.js';

const BAM_CORE = '0x000000000000000000000000000000000000c07e' as Address;
const CHAIN_ID = 11155111;

function baseConfig(): ReaderConfig {
  return {
    chainId: CHAIN_ID,
    rpcUrl: 'https://rpc.example',
    bamCoreAddress: BAM_CORE,
    reorgWindowBlocks: 32,
    dbUrl: 'memory:',
    httpBind: '127.0.0.1',
    httpPort: 0,
    ethCallGasCap: 50_000_000n,
    ethCallTimeoutMs: 5_000,
  };
}

function fakeL1(opts: { head: number }): LiveTailL1Client {
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
    async getParentBeaconBlockRoot() {
      return null;
    },
    async getLogs() {
      return [];
    },
  };
}

describe('ReaderHttpServer', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0)) {
      await c();
    }
  });

  it('returns the documented /health JSON shape on GET /health', async () => {
    const store = await createMemoryStore();
    await store.withTxn(async (txn) => {
      await txn.setCursor({
        chainId: CHAIN_ID,
        lastBlockNumber: 90,
        lastTxIndex: 2,
        updatedAt: 1700000000000,
      });
    });
    const reader = await createReader(baseConfig(), {
      l1: fakeL1({ head: 100 }),
      store,
    });
    cleanups.push(() => reader.close());

    const http = await ReaderHttpServer.start({ reader, host: '127.0.0.1', port: 0 });
    cleanups.push(() => http.close());
    const port = http.port();

    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      chainId: CHAIN_ID,
      cursor: {
        lastBlockNumber: 90,
        lastTxIndex: 2,
        updatedAt: 1700000000000,
      },
      blocksBehindHead: 10,
      counters: {
        decoded: 0,
        skippedDecode: 0,
        skippedVerify: 0,
        skippedConflict: 0,
        undecodable: 0,
      },
    });
  });

  it('binds to 127.0.0.1 by default (host accessor reflects this)', async () => {
    const reader = await createReader(baseConfig(), {
      l1: fakeL1({ head: 100 }),
      store: await createMemoryStore(),
    });
    cleanups.push(() => reader.close());
    const http = await ReaderHttpServer.start({ reader, port: 0 });
    cleanups.push(() => http.close());
    expect(http.hostname()).toBe('127.0.0.1');
  });

  it('returns 404 for unknown routes', async () => {
    const reader = await createReader(baseConfig(), {
      l1: fakeL1({ head: 100 }),
      store: await createMemoryStore(),
    });
    cleanups.push(() => reader.close());
    const http = await ReaderHttpServer.start({ reader, port: 0 });
    cleanups.push(() => http.close());
    const port = http.port();
    const res = await fetch(`http://127.0.0.1:${port}/does-not-exist`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: 'not_found' });
  });
});
