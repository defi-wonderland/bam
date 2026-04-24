import { afterEach, describe, expect, it } from 'vitest';
import type { Address, Bytes32 } from 'bam-sdk';

import { SqlitePosterStore } from '../src/sqlite.js';
import type { PosterStore } from '../src/types.js';

const TAG_A = ('0x' + 'aa'.repeat(32)) as Bytes32;
const TAG_B = ('0x' + 'bb'.repeat(32)) as Bytes32;
const ADDR_1 = ('0x' + '11'.repeat(20)) as Address;
const ADDR_2 = ('0x' + '22'.repeat(20)) as Address;
const HASH_1 = ('0x' + '77'.repeat(32)) as Bytes32;

const stores: PosterStore[] = [];

function newStore(): SqlitePosterStore {
  const s = new SqlitePosterStore(':memory:');
  stores.push(s);
  return s;
}

afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
});

function pendingRow(overrides = {}): Parameters<
  Parameters<PosterStore['withTxn']>[0] extends (txn: infer T) => unknown
    ? T extends { insertPending: (row: infer R) => unknown }
      ? (row: R) => unknown
      : never
    : never
>[0] {
  const contents = new Uint8Array(40);
  contents.fill(0xaa, 0, 32);
  return {
    contentTag: TAG_A,
    sender: ADDR_1,
    nonce: 1n,
    contents,
    signature: new Uint8Array(65),
    messageHash: HASH_1,
    ingestedAt: 1_000,
    ingestSeq: 1,
    ...overrides,
  };
}

describe('SqlitePosterStore — schema + schema version', () => {
  it('fresh DB self-initialises schema version to 2', () => {
    const store = newStore();
    expect(store.readSchemaVersion()).toBe(2);
  });

  it('all expected tables exist on a fresh DB', () => {
    const store = newStore();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (store as unknown as { db: any }).db;
    const names = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all()
      .map((r: { name: string }) => r.name);
    for (const t of [
      'poster_pending',
      'poster_nonces',
      'poster_submitted_batches',
      'poster_tag_seq',
      'poster_schema',
    ]) {
      expect(names).toContain(t);
    }
  });
});

describe('SqlitePosterStore — pending CRUD', () => {
  it('insert + getPendingByKey round-trip', async () => {
    const store = newStore();
    await store.withTxn(async (txn) => txn.insertPending(pendingRow()));
    const back = await store.withTxn(async (txn) =>
      txn.getPendingByKey({ sender: ADDR_1, nonce: 1n })
    );
    expect(back).not.toBeNull();
    expect(back!.messageHash).toBe(HASH_1);
    expect(back!.nonce).toBe(1n);
    expect(Array.from(back!.contents).slice(0, 32)).toEqual(
      new Array(32).fill(0xaa)
    );
  });

  it('duplicate (sender, nonce) insert rejects via PK', async () => {
    const store = newStore();
    await store.withTxn(async (txn) => txn.insertPending(pendingRow()));
    await expect(
      store.withTxn(async (txn) => txn.insertPending(pendingRow()))
    ).rejects.toThrow();
  });

  it('listPendingByTag returns per-tag FIFO', async () => {
    const store = newStore();
    await store.withTxn(async (txn) => {
      txn.insertPending(pendingRow({ nonce: 1n, ingestSeq: 1 }));
      txn.insertPending(pendingRow({ nonce: 2n, ingestSeq: 2 }));
      txn.insertPending(
        pendingRow({
          sender: ADDR_2,
          nonce: 1n,
          ingestSeq: 3,
          contentTag: TAG_B,
        })
      );
    });
    const rows = await store.withTxn(async (txn) => txn.listPendingByTag(TAG_A));
    expect(rows.map((r) => Number(r.nonce))).toEqual([1, 2]);
  });

  it('deletePending removes by (sender, nonce) composite keys', async () => {
    const store = newStore();
    await store.withTxn(async (txn) => {
      txn.insertPending(pendingRow({ nonce: 1n, ingestSeq: 1 }));
      txn.insertPending(pendingRow({ nonce: 2n, ingestSeq: 2 }));
    });
    await store.withTxn(async (txn) =>
      txn.deletePending([{ sender: ADDR_1, nonce: 1n }])
    );
    const rows = await store.withTxn(async (txn) => txn.listPendingByTag(TAG_A));
    expect(rows.map((r) => Number(r.nonce))).toEqual([2]);
  });

  it('nextIngestSeq persists across DELETEs (counter lives in its own table)', async () => {
    const store = newStore();
    const seqs: number[] = [];
    await store.withTxn(async (txn) => {
      seqs.push(txn.nextIngestSeq(TAG_A));
      seqs.push(txn.nextIngestSeq(TAG_A));
    });
    await store.withTxn(async (txn) =>
      txn.insertPending(pendingRow({ ingestSeq: seqs[0] }))
    );
    await store.withTxn(async (txn) =>
      txn.deletePending([{ sender: ADDR_1, nonce: 1n }])
    );
    const next = await store.withTxn(async (txn) => txn.nextIngestSeq(TAG_A));
    expect(next).toBe(3); // sequence did NOT reset after DELETE
  });
});

describe('SqlitePosterStore — nonce tracker', () => {
  it('set + get round-trip with lowercase normalisation', async () => {
    const store = newStore();
    const sender = ('0x' + 'AA'.repeat(20)) as Address;
    await store.withTxn(async (txn) =>
      txn.setNonce({ sender, lastNonce: 42n, lastMessageHash: HASH_1 })
    );
    const back = await store.withTxn(async (txn) => txn.getNonce(sender));
    expect(back).not.toBeNull();
    expect(back!.sender).toBe(sender.toLowerCase());
    expect(back!.lastNonce).toBe(42n);
  });

  it('uint64 boundary round-trips via TEXT(20)', async () => {
    const store = newStore();
    const maxUint64 = (1n << 64n) - 1n;
    await store.withTxn(async (txn) =>
      txn.setNonce({ sender: ADDR_1, lastNonce: maxUint64, lastMessageHash: HASH_1 })
    );
    const back = await store.withTxn(async (txn) => txn.getNonce(ADDR_1));
    expect(back!.lastNonce).toBe(maxUint64);
  });
});

describe('SqlitePosterStore — submitted batches', () => {
  it('insert + getSubmittedByTx round-trip (incl. batchContentHash)', async () => {
    const store = newStore();
    const row = {
      txHash: ('0x' + '01'.repeat(32)) as Bytes32,
      contentTag: TAG_A,
      blobVersionedHash: ('0x' + '02'.repeat(32)) as Bytes32,
      batchContentHash: ('0x' + '03'.repeat(32)) as Bytes32,
      blockNumber: 100,
      status: 'included' as const,
      replacedByTxHash: null,
      submittedAt: 2_000,
      invalidatedAt: null,
      messages: [
        {
          sender: ADDR_1,
          nonce: 1n,
          contents: new Uint8Array(32),
          signature: new Uint8Array(65),
          messageHash: HASH_1,
          messageId: ('0x' + '99'.repeat(32)) as Bytes32,
          originalIngestSeq: 1,
        },
      ],
    };
    await store.withTxn(async (txn) => txn.insertSubmitted(row));
    const back = await store.withTxn(async (txn) =>
      txn.getSubmittedByTx(row.txHash)
    );
    expect(back).not.toBeNull();
    expect(back!.batchContentHash).toBe(row.batchContentHash);
    expect(back!.messages.length).toBe(1);
    expect(back!.messages[0].messageId).toBe(row.messages[0].messageId);
    expect(back!.status).toBe('included');
  });

  it('updateSubmittedStatus applies invalidatedAt when reorged', async () => {
    const store = newStore();
    const txHash = ('0x' + '01'.repeat(32)) as Bytes32;
    await store.withTxn(async (txn) =>
      txn.insertSubmitted({
        txHash,
        contentTag: TAG_A,
        blobVersionedHash: ('0x' + '02'.repeat(32)) as Bytes32,
        batchContentHash: ('0x' + '03'.repeat(32)) as Bytes32,
        blockNumber: 100,
        status: 'included',
        replacedByTxHash: null,
        submittedAt: 2_000,
        invalidatedAt: null,
        messages: [],
      })
    );
    await store.withTxn(async (txn) =>
      txn.updateSubmittedStatus(txHash, 'reorged', null, null, 3_000)
    );
    const back = await store.withTxn(async (txn) =>
      txn.getSubmittedByTx(txHash)
    );
    expect(back!.status).toBe('reorged');
    expect(back!.invalidatedAt).toBe(3_000);
  });
});
