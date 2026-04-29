/**
 * Integration test for the Reader's read-only HTTP surface.
 *
 * Boots a real `ReaderHttpServer` over a `Reader` backed by an
 * in-memory PGLite store, populates fixture rows, and drives every
 * new read endpoint with `fetch`. Asserts the encoding contract
 * (`bigint` → decimal string, bytea → `0x`-hex) and confirms
 * `/health` still responds — the dispatcher change in T004 must not
 * regress the existing route.
 */

import type { Address, Bytes32 } from 'bam-sdk';
import { createMemoryStore } from 'bam-store';
import type {
  BamStore,
  BatchMessageSnapshotEntry,
  BatchRow,
  MessageRow,
} from 'bam-store';
import { afterEach, describe, expect, it } from 'vitest';

import { createReader } from '../../src/factory.js';
import { ReaderHttpServer } from '../../src/http/server.js';
import type { LiveTailL1Client } from '../../src/loop/live-tail.js';
import type { ReaderConfig } from '../../src/types.js';

const BAM_CORE = '0x000000000000000000000000000000000000c07e' as Address;
const CHAIN_ID = 11155111;

const TAG = ('0x' + 'aa'.repeat(32)) as Bytes32;
const ADDR = ('0x' + '11'.repeat(20)) as Address;
const TX_KNOWN = ('0x' + '01'.repeat(32)) as Bytes32;
const TX_OTHER = ('0x' + '02'.repeat(32)) as Bytes32;
const TX_UNKNOWN = ('0x' + 'ee'.repeat(32)) as Bytes32;
const BVH = ('0x' + '03'.repeat(32)) as Bytes32;
const BCH = ('0x' + '04'.repeat(32)) as Bytes32;
const MID = ('0x' + '99'.repeat(32)) as Bytes32;
const MHASH = ('0x' + '77'.repeat(32)) as Bytes32;

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

function fakeL1(): LiveTailL1Client {
  return {
    async getChainId() {
      return CHAIN_ID;
    },
    async getBlockNumber() {
      return 100n;
    },
    async getTransactionBlock() {
      return null;
    },
    async getBlockHeader() {
      return null;
    },
    async getLogs() {
      return [];
    },
  };
}

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
    contents: new Uint8Array([0xca, 0xfe, 0xba, 0xbe]),
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

describe('Reader HTTP integration — read endpoints over PGLite', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  async function bootServer(): Promise<{ port: number; store: BamStore }> {
    const store = await createMemoryStore();
    await store.withTxn(async (txn) => {
      await txn.upsertBatch(batchRow());
      await txn.upsertBatch(batchRow({ txHash: TX_OTHER, blockNumber: 11 }));
      await txn.upsertObserved(messageRow());
    });
    const reader = await createReader(baseConfig(), {
      l1: fakeL1(),
      store,
    });
    cleanups.push(() => reader.close());
    const http = await ReaderHttpServer.start({ reader, port: 0 });
    cleanups.push(() => http.close());
    return { port: http.port(), store };
  }

  it('GET /messages?batchRef=… filters to a single batch (per-batch detail view)', async () => {
    const { port, store } = await bootServer();
    // Add a second batch + a message under it so the filter has work to do.
    const TX_OTHER = ('0x' + '02'.repeat(32)) as Bytes32;
    const ADDR_OTHER = ('0x' + '22'.repeat(20)) as Address;
    await store.withTxn(async (txn) => {
      await txn.upsertBatch(batchRow({ txHash: TX_OTHER, blockNumber: 11 }));
      await txn.upsertObserved({
        ...messageRow(),
        author: ADDR_OTHER,
        nonce: 7n,
        batchRef: TX_OTHER,
        messageId: ('0x' + 'cd'.repeat(32)) as Bytes32,
        messageHash: ('0x' + 'ef'.repeat(32)) as Bytes32,
        blockNumber: 11,
      });
    });

    const res = await fetch(
      `http://127.0.0.1:${port}/messages?contentTag=${TAG}&batchRef=${TX_KNOWN}`
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.messages.length).toBe(1);
    expect(body.messages[0].batchRef).toBe(TX_KNOWN);
  });

  it('GET /messages returns rows with bigint→string and bytea→0x-hex encoding', async () => {
    const { port } = await bootServer();
    const res = await fetch(
      `http://127.0.0.1:${port}/messages?contentTag=${TAG}&status=confirmed`
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.messages.length).toBe(1);
    const row = body.messages[0];
    expect(typeof row.nonce).toBe('string');
    expect(row.nonce).toBe('1');
    expect(row.contents).toBe('0xcafebabe');
    expect(row.signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(row.contentTag).toBe(TAG);
    expect(row.batchRef).toBe(TX_KNOWN);
  });

  it('GET /batches returns rows; messageSnapshot bigint nonce stringified', async () => {
    const { port } = await bootServer();
    const res = await fetch(
      `http://127.0.0.1:${port}/batches?contentTag=${TAG}&status=confirmed`
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.batches)).toBe(true);
    expect(body.batches.length).toBe(2);
    for (const b of body.batches) {
      expect(b.contentTag).toBe(TAG);
      if (b.messageSnapshot.length > 0) {
        expect(typeof b.messageSnapshot[0].nonce).toBe('string');
      }
    }
  });

  it('GET /batches/:txHash — happy path returns the row, 404 for unknown', async () => {
    const { port } = await bootServer();
    const hit = await fetch(`http://127.0.0.1:${port}/batches/${TX_KNOWN}`);
    expect(hit.status).toBe(200);
    const hitBody = await hit.json();
    expect(hitBody.batch.txHash).toBe(TX_KNOWN);
    expect(hitBody.batch.messageSnapshot[0].nonce).toBe('1');

    const miss = await fetch(`http://127.0.0.1:${port}/batches/${TX_UNKNOWN}`);
    expect(miss.status).toBe(404);
    expect(await miss.json()).toEqual({ error: 'not_found' });
  });

  it('/health regression: still responds with the documented shape', async () => {
    const { port, store } = await bootServer();
    await store.withTxn((txn) =>
      txn.setCursor({
        chainId: CHAIN_ID,
        lastBlockNumber: 90,
        lastTxIndex: 0,
        updatedAt: 42,
      })
    );
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.chainId).toBe(CHAIN_ID);
    expect(body.cursor).toMatchObject({ lastBlockNumber: 90, lastTxIndex: 0 });
  });
});
