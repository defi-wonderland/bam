import { describe, expect, it } from 'vitest';
import type { Address, Bytes32 } from 'bam-sdk';

import { listPending } from '../src/surfaces/pending.js';
import { listSubmittedBatches } from '../src/surfaces/submitted.js';
import { readStatus } from '../src/surfaces/status.js';
import { readHealth } from '../src/surfaces/health.js';
import { createMemoryStore } from 'bam-store';
import type { BamStore, BatchStatus } from 'bam-store';
import type { Signer, StoreTxnPendingRow } from '../src/types.js';
import type { StatusRpcReader } from '../src/surfaces/status.js';

const TAG_A = ('0x' + 'aa'.repeat(32)) as Bytes32;
const TAG_B = ('0x' + 'bb'.repeat(32)) as Bytes32;
const SENDER = ('0x' + '11'.repeat(20)) as Address;
const WALLET = ('0x' + '99'.repeat(20)) as Address;

function pendingRow(overrides: Partial<StoreTxnPendingRow> = {}): StoreTxnPendingRow {
  const contents = new Uint8Array(40);
  contents.fill(0xaa, 0, 32);
  return {
    contentTag: TAG_A,
    sender: SENDER,
    nonce: 1n,
    contents,
    signature: new Uint8Array(65),
    messageHash: ('0x' + '77'.repeat(32)) as Bytes32,
    ingestedAt: 1_000,
    ingestSeq: 1,
    ...overrides,
  };
}

interface SeedMsg {
  nonce: number;
}

/**
 * Test shim: seed a batch + its messages through the unified-schema
 * ops, matching the expectation the old `submittedRow` helper set up.
 * status defaults to 'confirmed'; callers pass 'reorged' for reorged
 * fixtures.
 */
async function seedBatch(
  store: BamStore,
  opts: {
    txHash?: Bytes32;
    contentTag?: Bytes32;
    batchStatus?: BatchStatus;
    blockNumber?: number;
    invalidatedAt?: number | null;
    messages?: SeedMsg[];
  } = {}
): Promise<void> {
  const txHash = opts.txHash ?? (('0x' + '01'.repeat(32)) as Bytes32);
  const contentTag = opts.contentTag ?? TAG_A;
  const blockNumber = opts.blockNumber ?? 100;
  const batchStatus: BatchStatus = opts.batchStatus ?? 'confirmed';
  const msgs = opts.messages ?? [{ nonce: 1 }];
  const messageStatus =
    batchStatus === 'confirmed' ? 'confirmed' : batchStatus === 'reorged' ? 'reorged' : 'submitted';
  await store.withTxn(async (txn) => {
    await txn.upsertBatch({
      txHash,
      chainId: 31337,
      contentTag,
      blobVersionedHash: ('0x' + '02'.repeat(32)) as Bytes32,
      batchContentHash: ('0x' + '03'.repeat(32)) as Bytes32,
      blockNumber,
      txIndex: null,
      status: batchStatus,
      replacedByTxHash: null,
      submittedAt: 2_000,
      invalidatedAt: opts.invalidatedAt ?? null,
      messageSnapshot: msgs.map((m, i) => ({
        author: SENDER,
        nonce: BigInt(m.nonce),
        messageId: (('0x' + (m.nonce + 1000).toString(16).padStart(64, '0')) as Bytes32),
        messageHash: (('0x' + m.nonce.toString(16).padStart(64, '0')) as Bytes32),
        messageIndexWithinBatch: i,
      })),
    });
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      const contents = new Uint8Array(40);
      contents.fill(0xaa, 0, 32);
      await txn.upsertObserved({
        messageId: (('0x' + (m.nonce + 1000).toString(16).padStart(64, '0')) as Bytes32),
        author: SENDER,
        nonce: BigInt(m.nonce),
        contentTag,
        contents,
        signature: new Uint8Array(65),
        messageHash: (('0x' + m.nonce.toString(16).padStart(64, '0')) as Bytes32),
        status: messageStatus,
        batchRef: txHash,
        ingestedAt: null,
        ingestSeq: m.nonce,
        blockNumber: batchStatus === 'confirmed' ? blockNumber : null,
        txIndex: null,
        messageIndexWithinBatch: i,
      });
    }
  });
}

class StubSigner implements Signer {
  account() {
    return { address: WALLET, type: 'json-rpc' as const };
  }
}

describe('listPending', () => {
  it('returns BAMMessage-shaped rows with messageHash (no v1 content/timestamp)', async () => {
    const store = await createMemoryStore();
    await store.withTxn(async (txn) => txn.insertPending(pendingRow()));
    const rows = await listPending(store, {});
    expect(rows.length).toBe(1);
    expect(Object.keys(rows[0]).sort()).toEqual(
      ['contentTag', 'contents', 'ingestedAt', 'ingestSeq', 'messageHash', 'nonce', 'sender', 'signature'].sort()
    );
    expect(rows[0].messageHash).toBe('0x' + '77'.repeat(32));
  });

  it('filters by contentTag', async () => {
    const store = await createMemoryStore();
    await store.withTxn(async (txn) => {
      await txn.insertPending(pendingRow({ nonce: 1n, ingestSeq: 1 }));
      await txn.insertPending(pendingRow({ nonce: 2n, ingestSeq: 2, contentTag: TAG_B }));
    });
    const a = await listPending(store, { contentTag: TAG_A });
    expect(a.length).toBe(1);
    const b = await listPending(store, { contentTag: TAG_B });
    expect(b.length).toBe(1);
  });
});

describe('listSubmittedBatches', () => {
  it('status "included" → messageId is populated, invalidatedAt null', async () => {
    const store = await createMemoryStore();
    await seedBatch(store);
    const rows = await listSubmittedBatches(store, 31337, {});
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('included');
    expect(rows[0].invalidatedAt).toBeNull();
    expect(rows[0].messages[0].messageId).not.toBeNull();
  });

  it('status "reorged" → messageId is surfaced as null on every message', async () => {
    const store = await createMemoryStore();
    await seedBatch(store, { batchStatus: 'reorged', invalidatedAt: 3_000 });
    const rows = await listSubmittedBatches(store, 31337, {});
    expect(rows[0].status).toBe('reorged');
    expect(rows[0].invalidatedAt).toBe(3_000);
    for (const m of rows[0].messages) expect(m.messageId).toBeNull();
  });

  it('returns batchContentHash on every entry', async () => {
    const store = await createMemoryStore();
    await seedBatch(store);
    const rows = await listSubmittedBatches(store, 31337, {});
    expect(rows[0].batchContentHash).toBe('0x' + '03'.repeat(32));
  });

  it('filters by sinceBlock', async () => {
    const store = await createMemoryStore();
    await seedBatch(store, { txHash: ('0x' + '01'.repeat(32)) as Bytes32, blockNumber: 10 });
    await seedBatch(store, { txHash: ('0x' + '02'.repeat(32)) as Bytes32, blockNumber: 20 });
    const rows = await listSubmittedBatches(store, 31337, { sinceBlock: 15n });
    expect(rows.length).toBe(1);
    expect(rows[0].blockNumber).toBe(20);
  });

  it('filters out batches from a different chainId', async () => {
    const store = await createMemoryStore();
    await seedBatch(store, { txHash: ('0x' + '01'.repeat(32)) as Bytes32, blockNumber: 10 });
    // Write a batch on a different chain directly (bypassing seedBatch
    // which hardcodes 31337) to simulate a shared DB.
    await store.withTxn(async (txn) => {
      await txn.upsertBatch({
        txHash: ('0x' + '02'.repeat(32)) as Bytes32,
        chainId: 999,
        contentTag: TAG_A,
        blobVersionedHash: ('0x' + '02'.repeat(32)) as Bytes32,
        batchContentHash: ('0x' + '03'.repeat(32)) as Bytes32,
        blockNumber: 11,
        txIndex: null,
        status: 'confirmed',
        replacedByTxHash: null,
        submittedAt: 2_000,
        invalidatedAt: null,
        messageSnapshot: [],
      });
    });
    const rows = await listSubmittedBatches(store, 31337, {});
    expect(rows.length).toBe(1);
    expect(rows[0].txHash).toBe('0x' + '01'.repeat(32));
  });

  it('limit: 0 returns no batches', async () => {
    const store = await createMemoryStore();
    await seedBatch(store, { txHash: ('0x' + '01'.repeat(32)) as Bytes32 });
    await seedBatch(store, { txHash: ('0x' + '02'.repeat(32)) as Bytes32 });
    const rows = await listSubmittedBatches(store, 31337, { limit: 0 });
    expect(rows.length).toBe(0);
  });

  it('rejects non-finite or negative limit (programmatic-caller misuse)', async () => {
    const store = await createMemoryStore();
    await seedBatch(store);
    await expect(
      listSubmittedBatches(store, 31337, { limit: Number.NaN })
    ).rejects.toThrow(/non-negative integer/);
    await expect(
      listSubmittedBatches(store, 31337, { limit: Number.POSITIVE_INFINITY })
    ).rejects.toThrow(/non-negative integer/);
    await expect(
      listSubmittedBatches(store, 31337, { limit: -1 })
    ).rejects.toThrow(/non-negative integer/);
    await expect(
      listSubmittedBatches(store, 31337, { limit: 1.5 })
    ).rejects.toThrow(/non-negative integer/);
  });

  it('filters out batches with null submittedAt (Reader-observed, never submitted by us)', async () => {
    const store = await createMemoryStore();
    await seedBatch(store, { txHash: ('0x' + '01'.repeat(32)) as Bytes32 });
    // A batch a Reader observed without us ever submitting it: same
    // chain, but submittedAt is null because we didn't write it.
    await store.withTxn(async (txn) => {
      await txn.upsertBatch({
        txHash: ('0x' + '02'.repeat(32)) as Bytes32,
        chainId: 31337,
        contentTag: TAG_A,
        blobVersionedHash: ('0x' + '02'.repeat(32)) as Bytes32,
        batchContentHash: ('0x' + '03'.repeat(32)) as Bytes32,
        blockNumber: 200,
        txIndex: 0,
        status: 'confirmed',
        replacedByTxHash: null,
        submittedAt: null,
        invalidatedAt: null,
        messageSnapshot: [],
      });
    });
    const rows = await listSubmittedBatches(store, 31337, {});
    expect(rows.length).toBe(1);
    expect(rows[0].txHash).toBe('0x' + '01'.repeat(32));
  });
});

describe('readStatus', () => {
  it('returns wallet address + balance + per-tag pending counts', async () => {
    const store = await createMemoryStore();
    await store.withTxn(async (txn) => {
      await txn.insertPending(pendingRow({ nonce: 1n, ingestSeq: 1 }));
      await txn.insertPending(pendingRow({ nonce: 2n, ingestSeq: 2 }));
    });
    const rpc: StatusRpcReader = {
      async getBalance() {
        return 10n ** 18n;
      },
    };
    const s = await readStatus({
      store,
      rpc,
      signer: new StubSigner(),
      configuredTags: [TAG_A, TAG_B],
      chainId: 31337,
    });
    expect(s.walletAddress).toBe(WALLET);
    expect(s.walletBalanceWei).toBe(10n ** 18n);
    expect(s.pendingByTag.find((p) => p.contentTag === TAG_A)?.count).toBe(2);
    expect(s.pendingByTag.find((p) => p.contentTag === TAG_B)?.count).toBe(0);
  });

  it('surfaces lastSubmittedByTag', async () => {
    const store = await createMemoryStore();
    await seedBatch(store);
    const rpc: StatusRpcReader = {
      async getBalance() {
        return 0n;
      },
    };
    const s = await readStatus({
      store,
      rpc,
      signer: new StubSigner(),
      configuredTags: [TAG_A],
      chainId: 31337,
    });
    expect(s.lastSubmittedByTag.length).toBe(1);
    expect(s.lastSubmittedByTag[0].txHash).toBe('0x' + '01'.repeat(32));
  });
});

describe('readHealth', () => {
  it('ok state returns { state: "ok" } only (no reason/since leak)', () => {
    const h = readHealth({ submissionState: 'ok' });
    expect(h.state).toBe('ok');
    expect('reason' in h).toBe(false);
    expect('since' in h).toBe(false);
  });

  it('degraded returns state + reason', () => {
    const since = new Date(5_000);
    const h = readHealth({ submissionState: 'degraded', reason: 'rpc_down', since });
    expect(h).toEqual({ state: 'degraded', reason: 'rpc_down', since });
  });

  it('unhealthy returns state + reason', () => {
    const h = readHealth({ submissionState: 'unhealthy', reason: 'abi_mismatch' });
    expect(h.state).toBe('unhealthy');
    expect(h.reason).toBe('abi_mismatch');
  });
});
