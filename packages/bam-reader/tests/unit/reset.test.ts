/**
 * `bam-reader reset` — round-trip the factory's resetCursor / resetAll
 * against an in-process memory store, plus argv parsing for the
 * `reset` subcommand.
 *
 * Subprocess coverage (missing --yes refusal exit code, end-to-end
 * memory-store reset) lives next to the existing subprocess tests in
 * `bin.test.ts`; this file stays in-process so it doesn't pay the
 * compile-and-spawn cost.
 */

import type { Address, Bytes32 } from 'bam-sdk';
import { createMemoryStore } from 'bam-store';
import type { BatchRow, MessageRow } from 'bam-store';
import { describe, expect, it } from 'vitest';

import { ArgParseError, parseArgs } from '../../src/bin/bam-reader.js';
import { createReader } from '../../src/factory.js';
import type { LiveTailL1Client } from '../../src/loop/live-tail.js';
import type { ReaderConfig } from '../../src/types.js';

const BAM_CORE = '0x000000000000000000000000000000000000c07e' as Address;
const TAG = ('0x' + 'aa'.repeat(32)) as Bytes32;
const ADDR = ('0x' + '11'.repeat(20)) as Address;
const TX = ('0x' + '01'.repeat(32)) as Bytes32;
const BVH = ('0x' + '03'.repeat(32)) as Bytes32;
const BCH = ('0x' + '04'.repeat(32)) as Bytes32;
const MID = ('0x' + '99'.repeat(32)) as Bytes32;
const MHASH = ('0x' + '77'.repeat(32)) as Bytes32;

function baseConfig(chainId = 11155111): ReaderConfig {
  return {
    chainId,
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

function fakeL1(chainId: number): LiveTailL1Client {
  return {
    async getChainId() {
      return chainId;
    },
    async getBlockNumber() {
      return 100n;
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

function batchRow(over: Partial<BatchRow> = {}): BatchRow {
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
    submittedAt: 1_000,
    invalidatedAt: null,
    submitter: null,
    l1IncludedAtUnixSec: null,
    messageSnapshot: [
      {
        author: ADDR,
        nonce: 1n,
        messageId: MID,
        messageHash: MHASH,
        messageIndexWithinBatch: 0,
      },
    ],
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
    batchRef: TX,
    chainId: 11155111,
    ingestedAt: null,
    ingestSeq: null,
    blockNumber: 10,
    txIndex: 0,
    messageIndexWithinBatch: 0,
    ...over,
  };
}

async function seededReader() {
  const store = await createMemoryStore();
  await store.withTxn(async (txn) => {
    await txn.upsertBatch(batchRow());
    await txn.upsertObserved(messageRow());
    await txn.setCursor({
      chainId: 11155111,
      lastBlockNumber: 42,
      lastTxIndex: 0,
      updatedAt: 1_700_000_000_000,
    });
  });
  const reader = await createReader(baseConfig(), {
    l1: fakeL1(11155111),
    store,
  });
  return { reader, store };
}

describe('Reader.resetCursor', () => {
  it('drops the reader_cursor row for the configured chain', async () => {
    const { reader, store } = await seededReader();
    expect(await reader.cursorBlock()).toBe(42);
    await reader.resetCursor();
    expect(await reader.cursorBlock()).toBeNull();
    // batches + messages survive
    const batches = await reader.listBatches({ contentTag: TAG });
    const messages = await reader.listConfirmedMessages({ contentTag: TAG });
    expect(batches.length).toBe(1);
    expect(messages.length).toBe(1);
    await reader.close();
    await store.close();
  });

  it('is idempotent — second call against an empty cursor is a no-op', async () => {
    const { reader, store } = await seededReader();
    await reader.resetCursor();
    await reader.resetCursor();
    expect(await reader.cursorBlock()).toBeNull();
    await reader.close();
    await store.close();
  });

  it('honors an explicit chainId argument and leaves other chains intact', async () => {
    // Seed a second chain alongside the configured one; resetCursor(otherChain)
    // must only nuke the other chain's cursor.
    const { reader, store } = await seededReader();
    await store.withTxn((txn) =>
      txn.setCursor({
        chainId: 1,
        lastBlockNumber: 99,
        lastTxIndex: 0,
        updatedAt: 1_700_000_000_000,
      })
    );
    await reader.resetCursor(1);
    expect(await reader.cursorBlock()).toBe(42); // configured chain untouched
    await store.withTxn(async (txn) => {
      expect(await txn.getCursor(1)).toBeNull();
    });
    await reader.close();
    await store.close();
  });
});

describe('Reader.resetAll', () => {
  it('drops cursor, batches, and messages for the configured chain', async () => {
    const { reader, store } = await seededReader();
    await reader.resetAll();
    expect(await reader.cursorBlock()).toBeNull();
    expect((await reader.listBatches({ contentTag: TAG })).length).toBe(0);
    expect((await reader.listConfirmedMessages({ contentTag: TAG })).length).toBe(0);
    await reader.close();
    await store.close();
  });

  it('is chain-scoped — rows on a different chain survive', async () => {
    const { reader, store } = await seededReader();
    // Seed a row on a different chain (chainId=1).
    await store.withTxn(async (txn) => {
      await txn.upsertBatch(
        batchRow({
          chainId: 1,
          txHash: ('0x' + 'bb'.repeat(32)) as Bytes32,
        })
      );
    });
    await reader.resetAll();
    // resetAll defaulted to the configured chainId (sepolia); chain=1 batches
    // must still be there.
    await store.withTxn(async (txn) => {
      const surviving = await txn.listBatches({ chainId: 1 });
      expect(surviving.length).toBe(1);
    });
    await reader.close();
    await store.close();
  });
});

describe('parseArgs — reset subcommand', () => {
  it('parses `reset --cursor --yes`', () => {
    expect(parseArgs(['reset', '--cursor', '--yes'])).toEqual({
      subcommand: 'reset',
      scope: 'cursor',
      confirmed: true,
    });
  });

  it('parses `reset --all --yes`', () => {
    expect(parseArgs(['reset', '--all', '--yes'])).toEqual({
      subcommand: 'reset',
      scope: 'all',
      confirmed: true,
    });
  });

  it('parses without --yes and reports confirmed=false (caller refuses to run)', () => {
    expect(parseArgs(['reset', '--cursor'])).toEqual({
      subcommand: 'reset',
      scope: 'cursor',
      confirmed: false,
    });
  });

  it('rejects `reset` with neither --cursor nor --all', () => {
    expect(() => parseArgs(['reset', '--yes'])).toThrow(ArgParseError);
    expect(() => parseArgs(['reset', '--yes'])).toThrow(/--cursor or --all/);
  });

  it('rejects `reset --cursor --all` (mutually exclusive)', () => {
    expect(() => parseArgs(['reset', '--cursor', '--all', '--yes'])).toThrow(
      /mutually exclusive/
    );
  });

  it('rejects unknown flags under reset', () => {
    expect(() => parseArgs(['reset', '--cursor', '--force'])).toThrow(/unknown flag/);
  });
});
