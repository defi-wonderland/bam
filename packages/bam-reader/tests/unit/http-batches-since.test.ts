/**
 * `GET /batches?since=<unixSec>` — inclusive lower bound on
 * `l1IncludedAtUnixSec`, threaded into `BatchesQuery`. Validation
 * mirrors `?limit=`: non-negative integer string only; empty or
 * missing → no filter applied.
 */

import type { Address, Bytes32 } from 'bam-sdk';
import type { BatchesQuery, BatchRow, MessagesQuery } from 'bam-store';
import { afterEach, describe, expect, it } from 'vitest';

import { ReaderHttpServer } from '../../src/http/server.js';
import type { Reader } from '../../src/factory.js';

const TAG = ('0x' + 'aa'.repeat(32)) as Bytes32;
const TX = ('0x' + '01'.repeat(32)) as Bytes32;
const BVH = ('0x' + '03'.repeat(32)) as Bytes32;
const BCH = ('0x' + '04'.repeat(32)) as Bytes32;
const ADDR = ('0x' + '11'.repeat(20)) as Address;

function fakeBatch(): BatchRow {
  return {
    txHash: TX,
    chainId: 11155111,
    contentTag: TAG,
    blobVersionedHash: BVH,
    batchContentHash: BCH,
    blockNumber: 10,
    txIndex: 0,
    status: 'confirmed',
    replacedByTxHash: null,
    submittedAt: null,
    invalidatedAt: null,
    submitter: ADDR,
    l1IncludedAtUnixSec: 1700000000,
    messageSnapshot: [],
  };
}

interface SpyReader extends Reader {
  calls: BatchesQuery[];
}

function spyReader(): SpyReader {
  const calls: BatchesQuery[] = [];
  return {
    calls,
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
      return {} as never;
    },
    async close() {},
    async listConfirmedMessages(_q: MessagesQuery) {
      return [];
    },
    async listBatches(q: BatchesQuery) {
      calls.push(q);
      return [fakeBatch()];
    },
    async getBatch() {
      return null;
    },
    async cursorBlock() {
      return null;
    },
    async resetCursor() {},
    async resetAll() {},
    async getBlob() {
      return null;
    },
  };
}

describe('GET /batches ?since= filter', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0)) {
      await c();
    }
  });

  async function boot(): Promise<{ port: number; reader: SpyReader }> {
    const reader = spyReader();
    const http = await ReaderHttpServer.start({ reader, port: 0 });
    cleanups.push(() => http.close());
    return { port: http.port(), reader };
  }

  it('forwards a valid since=<unixSec> to the store as a bigint', async () => {
    const { port, reader } = await boot();
    const res = await fetch(
      `http://127.0.0.1:${port}/batches?contentTag=${TAG}&since=1700000000`
    );
    expect(res.status).toBe(200);
    expect(reader.calls).toHaveLength(1);
    expect(reader.calls[0]!.sinceIncludedAtUnixSec).toBe(1700000000n);
  });

  it('treats an empty since= value as absent (no filter on the store query)', async () => {
    const { port, reader } = await boot();
    const res = await fetch(`http://127.0.0.1:${port}/batches?contentTag=${TAG}&since=`);
    expect(res.status).toBe(200);
    expect(reader.calls).toHaveLength(1);
    expect(reader.calls[0]!.sinceIncludedAtUnixSec).toBeUndefined();
  });

  it('omits the filter entirely when since is not in the query string', async () => {
    const { port, reader } = await boot();
    const res = await fetch(`http://127.0.0.1:${port}/batches?contentTag=${TAG}`);
    expect(res.status).toBe(200);
    expect(reader.calls).toHaveLength(1);
    expect(reader.calls[0]!.sinceIncludedAtUnixSec).toBeUndefined();
  });

  it('rejects a negative since with 400 bad_request reason=since', async () => {
    const { port, reader } = await boot();
    const res = await fetch(
      `http://127.0.0.1:${port}/batches?contentTag=${TAG}&since=-1`
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad_request', reason: 'since' });
    expect(reader.calls).toEqual([]);
  });

  it('rejects a non-integer since with 400 bad_request reason=since', async () => {
    const { port, reader } = await boot();
    const res = await fetch(
      `http://127.0.0.1:${port}/batches?contentTag=${TAG}&since=abc`
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad_request', reason: 'since' });
    expect(reader.calls).toEqual([]);
  });

  it('rejects since values above Number.MAX_SAFE_INTEGER with 400', async () => {
    const { port, reader } = await boot();
    const res = await fetch(
      `http://127.0.0.1:${port}/batches?contentTag=${TAG}&since=99999999999999999`
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad_request', reason: 'since' });
    expect(reader.calls).toEqual([]);
  });
});
