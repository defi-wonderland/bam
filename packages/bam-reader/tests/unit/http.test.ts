import type { Address, Bytes32 } from 'bam-sdk';
import { createMemoryStore } from 'bam-store';
import type {
  BamStore,
  BatchMessageSnapshotEntry,
  BatchRow,
  MessageRow,
} from 'bam-store';
import { afterEach, describe, expect, it } from 'vitest';

import { createReader, type Reader } from '../../src/factory.js';
import { ReaderHttpServer, ROUTES } from '../../src/http/server.js';
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

  // ── read endpoints — fixtures + helpers (features 005 T005–T007) ────
  const TAG = ('0x' + 'aa'.repeat(32)) as Bytes32;
  const TAG_OTHER = ('0x' + 'bb'.repeat(32)) as Bytes32;
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
      chainId: CHAIN_ID,
      contentTag: TAG,
      blobVersionedHash: BVH,
      batchContentHash: BCH,
      blockNumber: 10,
      txIndex: 0,
      status: 'confirmed',
      replacedByTxHash: null,
      submittedAt: 1_000,
      invalidatedAt: null,
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
      contents: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
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

  async function bootSeededServer(): Promise<{ port: number; store: BamStore }> {
    const store = await createMemoryStore();
    await store.withTxn(async (txn) => {
      await txn.upsertBatch(batchRow());
      await txn.upsertBatch(batchRow({ txHash: TX_OTHER, blockNumber: 11 }));
      await txn.upsertObserved(messageRow());
    });
    const reader = await createReader(baseConfig(), {
      l1: fakeL1({ head: 100 }),
      store,
    });
    cleanups.push(() => reader.close());
    const http = await ReaderHttpServer.start({ reader, port: 0 });
    cleanups.push(() => http.close());
    return { port: http.port(), store };
  }

  async function bootThrowingServer(): Promise<{ port: number }> {
    const stub: Reader = {
      async serve() {},
      async backfill() {
        return {
          scanned: 0,
          processed: 0,
          decoded: 0,
          skippedDecode: 0,
          skippedVerify: 0,
          skippedConflict: 0,
          undecodable: 0,
        } as never;
      },
      async health() {
        throw new Error('not used');
      },
      async close() {},
      async listConfirmedMessages() {
        throw new Error('boom: details that must not leak (driver/dsn)');
      },
      async listBatches() {
        throw new Error('boom: details that must not leak (driver/dsn)');
      },
      async getBatch() {
        throw new Error('boom: details that must not leak (driver/dsn)');
      },
    };
    const http = await ReaderHttpServer.start({ reader: stub, port: 0 });
    cleanups.push(() => http.close());
    return { port: http.port() };
  }

  // ── T005 — GET /messages ─────────────────────────────────────────────
  describe('GET /messages', () => {
    it('returns seeded confirmed rows; bigint stringified, bytea as 0x-hex', async () => {
      const { port } = await bootSeededServer();
      const res = await fetch(
        `http://127.0.0.1:${port}/messages?contentTag=${TAG}&status=confirmed`
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body.messages)).toBe(true);
      expect(body.messages.length).toBe(1);
      const row = body.messages[0];
      expect(row.author.toLowerCase()).toBe(ADDR.toLowerCase());
      expect(row.nonce).toBe('1'); // bigint → decimal string
      expect(row.contents).toBe('0xdeadbeef'); // Uint8Array → 0x-hex
      expect(row.signature).toBe('0x' + '00'.repeat(65));
      expect(row.contentTag).toBe(TAG);
    });

    it('rejects missing contentTag with 400 bad_request', async () => {
      const { port } = await bootSeededServer();
      const res = await fetch(`http://127.0.0.1:${port}/messages`);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'bad_request', reason: 'contentTag' });
    });

    it('rejects malformed contentTag with 400', async () => {
      const { port } = await bootSeededServer();
      const res = await fetch(`http://127.0.0.1:${port}/messages?contentTag=0xnope`);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'bad_request', reason: 'contentTag' });
    });

    it('rejects invalid status with 400', async () => {
      const { port } = await bootSeededServer();
      const res = await fetch(
        `http://127.0.0.1:${port}/messages?contentTag=${TAG}&status=bogus`
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'bad_request', reason: 'status' });
    });

    it('rejects out-of-range and non-integer limit with 400', async () => {
      const { port } = await bootSeededServer();
      const tooBig = await fetch(
        `http://127.0.0.1:${port}/messages?contentTag=${TAG}&limit=10000`
      );
      expect(tooBig.status).toBe(400);
      expect(await tooBig.json()).toEqual({ error: 'bad_request', reason: 'limit' });

      const zero = await fetch(
        `http://127.0.0.1:${port}/messages?contentTag=${TAG}&limit=0`
      );
      expect(zero.status).toBe(400);

      const notInt = await fetch(
        `http://127.0.0.1:${port}/messages?contentTag=${TAG}&limit=10.5`
      );
      expect(notInt.status).toBe(400);
    });

    it('returns flat internal_error on a thrown read; no detail leaked', async () => {
      const { port } = await bootThrowingServer();
      const res = await fetch(
        `http://127.0.0.1:${port}/messages?contentTag=${TAG}`
      );
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body).toEqual({ error: 'internal_error' });
      expect(JSON.stringify(body)).not.toContain('driver');
      expect(JSON.stringify(body)).not.toContain('dsn');
    });

    it('filters by batchRef when supplied (drives the per-batch detail view)', async () => {
      const { port } = await bootSeededServer();
      const hit = await fetch(
        `http://127.0.0.1:${port}/messages?contentTag=${TAG}&batchRef=${TX_KNOWN}`
      );
      expect(hit.status).toBe(200);
      const body = await hit.json();
      expect(body.messages.length).toBe(1);
      expect(body.messages[0].batchRef).toBe(TX_KNOWN);

      const miss = await fetch(
        `http://127.0.0.1:${port}/messages?contentTag=${TAG}&batchRef=${TX_OTHER}`
      );
      expect(miss.status).toBe(200);
      expect((await miss.json()).messages).toEqual([]);
    });

    it('rejects malformed batchRef with 400', async () => {
      const { port } = await bootSeededServer();
      const res = await fetch(
        `http://127.0.0.1:${port}/messages?contentTag=${TAG}&batchRef=0xnotahash`
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'bad_request', reason: 'batchRef' });
    });
  });

  // ── T006 — GET /batches ──────────────────────────────────────────────
  describe('GET /batches', () => {
    it('returns seeded batches; bigint stringified, bytea as 0x-hex', async () => {
      const { port } = await bootSeededServer();
      const res = await fetch(
        `http://127.0.0.1:${port}/batches?contentTag=${TAG}&status=confirmed`
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body.batches)).toBe(true);
      expect(body.batches.length).toBe(2);
      const hashes = body.batches.map((b: { txHash: string }) => b.txHash).sort();
      expect(hashes).toEqual([TX_KNOWN, TX_OTHER].sort());
      const first = body.batches[0];
      expect(first.contentTag).toBe(TAG);
      // messageSnapshot's nonce is bigint and must stringify
      if (first.messageSnapshot.length > 0) {
        expect(first.messageSnapshot[0].nonce).toBe('1');
      }
    });

    it('respects status filter and returns empty when none match', async () => {
      const { port } = await bootSeededServer();
      const res = await fetch(
        `http://127.0.0.1:${port}/batches?contentTag=${TAG}&status=reorged`
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.batches).toEqual([]);
    });

    it('rejects missing contentTag with 400', async () => {
      const { port } = await bootSeededServer();
      const res = await fetch(`http://127.0.0.1:${port}/batches`);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'bad_request', reason: 'contentTag' });
    });

    it('rejects invalid status with 400', async () => {
      const { port } = await bootSeededServer();
      const res = await fetch(
        `http://127.0.0.1:${port}/batches?contentTag=${TAG}&status=confirmedX`
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'bad_request', reason: 'status' });
    });

    it('rejects out-of-range limit with 400', async () => {
      const { port } = await bootSeededServer();
      const res = await fetch(
        `http://127.0.0.1:${port}/batches?contentTag=${TAG}&limit=-1`
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'bad_request', reason: 'limit' });
    });

    it('returns 200 with no rows for an unknown tag (boundary, not 404)', async () => {
      const { port } = await bootSeededServer();
      const res = await fetch(
        `http://127.0.0.1:${port}/batches?contentTag=${TAG_OTHER}`
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ batches: [] });
    });

    it('returns flat internal_error on a thrown read', async () => {
      const { port } = await bootThrowingServer();
      const res = await fetch(
        `http://127.0.0.1:${port}/batches?contentTag=${TAG}`
      );
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'internal_error' });
    });
  });

  // ── T007 — GET /batches/:txHash ──────────────────────────────────────
  describe('GET /batches/:txHash', () => {
    it('returns the matching batch on a known hash', async () => {
      const { port } = await bootSeededServer();
      const res = await fetch(`http://127.0.0.1:${port}/batches/${TX_KNOWN}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.batch).toBeDefined();
      expect(body.batch.txHash).toBe(TX_KNOWN);
      expect(body.batch.contentTag).toBe(TAG);
      // bigint inside snapshot stringified
      expect(body.batch.messageSnapshot[0].nonce).toBe('1');
    });

    it('returns 404 not_found on an unknown hash', async () => {
      const { port } = await bootSeededServer();
      const res = await fetch(`http://127.0.0.1:${port}/batches/${TX_UNKNOWN}`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'not_found' });
    });

    it('returns 400 bad_request on a malformed txHash', async () => {
      const { port } = await bootSeededServer();
      const res = await fetch(`http://127.0.0.1:${port}/batches/0xdeadbeef`);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'bad_request', reason: 'txHash' });
    });

    it('returns flat internal_error on a thrown read', async () => {
      const { port } = await bootThrowingServer();
      const res = await fetch(`http://127.0.0.1:${port}/batches/${TX_KNOWN}`);
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'internal_error' });
    });
  });

  // ── T008 — read-only HTTP surface gate (G-5) ─────────────────────────
  describe('route table audit', () => {
    it('every entry in ROUTES is GET (read-only HTTP surface)', () => {
      expect(ROUTES.length).toBeGreaterThan(0);
      for (const route of ROUTES) {
        expect(route.method).toBe('GET');
      }
    });

    it('rejects nested paths under a :param segment with 404 not_found', async () => {
      // `matchRoute` requires the trailing segment to contain no
      // further `/`. Guard against a future router refactor that
      // accidentally lets `/batches/:txHash/anything` fall through.
      const { port } = await bootSeededServer();
      const res = await fetch(
        `http://127.0.0.1:${port}/batches/${TX_KNOWN}/extra`
      );
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'not_found' });
    });

    it('returns 404 (not 500) on malformed percent-encoding in the path param', async () => {
      // `decodeURIComponent('%ZZ')` throws `URIError`. The router
      // must catch it and treat the request as a route mismatch
      // rather than letting it bubble up to the dispatcher's
      // generic 500 handler.
      const { port } = await bootSeededServer();
      const res = await fetch(`http://127.0.0.1:${port}/batches/%ZZ`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'not_found' });
    });
  });
});
