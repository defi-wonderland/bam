import { describe, expect, it } from 'vitest';
import type { Address, Bytes32 } from 'bam-sdk';

import { createMemoryStore, MemoryBamStore } from '../src/memory-store.js';
import type {
  MessageSnapshot,
  StoreTxnPendingRow,
  StoreTxnSubmittedRow,
} from '../src/types.js';

const TAG_A = ('0x' + 'aa'.repeat(32)) as Bytes32;
const TAG_B = ('0x' + 'bb'.repeat(32)) as Bytes32;
const ADDR_1 = ('0x' + '11'.repeat(20)) as Address;
const ADDR_2 = ('0x' + '22'.repeat(20)) as Address;

function pendingRow(overrides: Partial<StoreTxnPendingRow> = {}): StoreTxnPendingRow {
  const contents = new Uint8Array(40);
  contents.fill(0xaa, 0, 32); // contentTag prefix
  return {
    contentTag: TAG_A,
    sender: ADDR_1,
    nonce: 1n,
    contents,
    signature: new Uint8Array(65),
    messageHash: ('0x' + '77'.repeat(32)) as Bytes32,
    ingestedAt: 1_000,
    ingestSeq: 1,
    ...overrides,
  };
}

function msgSnapshot(overrides: Partial<MessageSnapshot> = {}): MessageSnapshot {
  return {
    sender: ADDR_1,
    nonce: 1n,
    contents: new Uint8Array(32),
    signature: new Uint8Array(65),
    messageHash: ('0x' + '77'.repeat(32)) as Bytes32,
    messageId: ('0x' + '99'.repeat(32)) as Bytes32,
    originalIngestSeq: 1,
    ...overrides,
  };
}

function submittedRow(overrides: Partial<StoreTxnSubmittedRow> = {}): StoreTxnSubmittedRow {
  return {
    txHash: ('0x' + '01'.repeat(32)) as Bytes32,
    contentTag: TAG_A,
    blobVersionedHash: ('0x' + '02'.repeat(32)) as Bytes32,
    batchContentHash: ('0x' + '03'.repeat(32)) as Bytes32,
    blockNumber: 100,
    status: 'included',
    replacedByTxHash: null,
    submittedAt: 2_000,
    invalidatedAt: null,
    messages: [msgSnapshot()],
    ...overrides,
  };
}

describe('MemoryBamStore — pending CRUD', () => {
  it('insertPending + getPendingByKey round-trip', async () => {
    const store = createMemoryStore();
    const row = pendingRow();
    await store.withTxn(async (txn) => {
      txn.insertPending(row);
    });
    const back = await store.withTxn(async (txn) =>
      txn.getPendingByKey({ sender: row.sender, nonce: row.nonce })
    );
    expect(back).not.toBeNull();
    expect(back!.sender.toLowerCase()).toBe(row.sender.toLowerCase());
    expect(back!.nonce).toBe(row.nonce);
    expect(Array.from(back!.contents)).toEqual(Array.from(row.contents));
  });

  it('getPendingByKey returns null for missing (sender, nonce)', async () => {
    const store = createMemoryStore();
    const back = await store.withTxn(async (txn) =>
      txn.getPendingByKey({ sender: ADDR_1, nonce: 42n })
    );
    expect(back).toBeNull();
  });

  it('duplicate (sender, nonce) insert throws', async () => {
    const store = createMemoryStore();
    await store.withTxn(async (txn) => txn.insertPending(pendingRow()));
    await expect(
      store.withTxn(async (txn) => txn.insertPending(pendingRow()))
    ).rejects.toThrow();
  });

  it('listPendingByTag returns per-tag FIFO by ingest_seq', async () => {
    const store = createMemoryStore();
    await store.withTxn(async (txn) => {
      txn.insertPending(pendingRow({ nonce: 1n, ingestSeq: 1 }));
      txn.insertPending(pendingRow({ nonce: 2n, ingestSeq: 2 }));
      txn.insertPending(
        pendingRow({ sender: ADDR_2, nonce: 1n, ingestSeq: 3, contentTag: TAG_B })
      );
    });
    const aRows = await store.withTxn(async (txn) => txn.listPendingByTag(TAG_A));
    expect(aRows.map((r) => Number(r.nonce))).toEqual([1, 2]);
    const bRows = await store.withTxn(async (txn) => txn.listPendingByTag(TAG_B));
    expect(bRows.map((r) => Number(r.nonce))).toEqual([1]);
  });

  it('listPendingByTag respects sinceSeq + limit', async () => {
    const store = createMemoryStore();
    await store.withTxn(async (txn) => {
      for (let i = 1; i <= 5; i++) {
        txn.insertPending(pendingRow({ nonce: BigInt(i), ingestSeq: i }));
      }
    });
    const rows = await store.withTxn(async (txn) =>
      txn.listPendingByTag(TAG_A, 2, 1)
    );
    expect(rows.map((r) => r.ingestSeq)).toEqual([2, 3]);
  });

  it('deletePending removes selected keys only', async () => {
    const store = createMemoryStore();
    await store.withTxn(async (txn) => {
      txn.insertPending(pendingRow({ nonce: 1n, ingestSeq: 1 }));
      txn.insertPending(pendingRow({ nonce: 2n, ingestSeq: 2 }));
      txn.insertPending(pendingRow({ nonce: 3n, ingestSeq: 3 }));
    });
    await store.withTxn(async (txn) =>
      txn.deletePending([
        { sender: ADDR_1, nonce: 1n },
        { sender: ADDR_1, nonce: 3n },
      ])
    );
    const rows = await store.withTxn(async (txn) => txn.listPendingByTag(TAG_A));
    expect(rows.map((r) => Number(r.nonce))).toEqual([2]);
  });

  it('countPendingByTag reflects the pool state', async () => {
    const store = createMemoryStore();
    const count0 = await store.withTxn((txn) =>
      Promise.resolve(txn.countPendingByTag(TAG_A))
    );
    expect(count0).toBe(0);
    await store.withTxn(async (txn) => {
      txn.insertPending(pendingRow({ nonce: 1n, ingestSeq: 1 }));
      txn.insertPending(pendingRow({ nonce: 2n, ingestSeq: 2 }));
    });
    const count2 = await store.withTxn((txn) =>
      Promise.resolve(txn.countPendingByTag(TAG_A))
    );
    expect(count2).toBe(2);
  });

  it('nextIngestSeq is monotonic per-tag and does NOT regress on delete', async () => {
    const store = createMemoryStore();
    const seqs: number[] = [];
    await store.withTxn(async (txn) => {
      seqs.push(txn.nextIngestSeq(TAG_A));
      seqs.push(txn.nextIngestSeq(TAG_A));
      seqs.push(txn.nextIngestSeq(TAG_A));
    });
    expect(seqs).toEqual([1, 2, 3]);

    await store.withTxn(async (txn) => {
      txn.insertPending(pendingRow({ ingestSeq: seqs[0] }));
    });
    await store.withTxn(async (txn) =>
      txn.deletePending([{ sender: ADDR_1, nonce: 1n }])
    );
    const after = await store.withTxn((txn) =>
      Promise.resolve(txn.nextIngestSeq(TAG_A))
    );
    expect(after).toBe(4);
  });
});

describe('MemoryBamStore — nonce tracker', () => {
  it('setNonce + getNonce round-trip (lowercased sender)', async () => {
    const store = createMemoryStore();
    const sender = ('0x' + 'AA'.repeat(20)) as Address;
    await store.withTxn(async (txn) =>
      txn.setNonce({
        sender,
        lastNonce: 42n,
        lastMessageHash: ('0x' + 'bb'.repeat(32)) as Bytes32,
      })
    );
    const back = await store.withTxn(async (txn) => txn.getNonce(sender));
    expect(back).not.toBeNull();
    expect(back!.sender).toBe(sender.toLowerCase());
    expect(back!.lastNonce).toBe(42n);
  });

  it('mixed-case sender merges with the same record', async () => {
    const store = createMemoryStore();
    await store.withTxn(async (txn) =>
      txn.setNonce({
        sender: ('0x' + 'AA'.repeat(20)) as Address,
        lastNonce: 1n,
        lastMessageHash: ('0x' + 'bb'.repeat(32)) as Bytes32,
      })
    );
    const back = await store.withTxn(async (txn) =>
      txn.getNonce(('0x' + 'aa'.repeat(20)) as Address)
    );
    expect(back!.lastNonce).toBe(1n);
  });
});

describe('MemoryBamStore — submitted batches', () => {
  it('insertSubmitted + getSubmittedByTx round-trip (contents preserved)', async () => {
    const store = createMemoryStore();
    const row = submittedRow();
    await store.withTxn(async (txn) => txn.insertSubmitted(row));
    const back = await store.withTxn((txn) =>
      Promise.resolve(txn.getSubmittedByTx(row.txHash))
    );
    expect(back).not.toBeNull();
    expect(back!.batchContentHash).toBe(row.batchContentHash);
    expect(back!.messages.length).toBe(1);
    expect(back!.messages[0].messageId).toBe(row.messages[0].messageId);
  });

  it('listSubmitted filters by contentTag + sinceBlock', async () => {
    const store = createMemoryStore();
    await store.withTxn(async (txn) => {
      txn.insertSubmitted(
        submittedRow({ txHash: ('0x' + '01'.repeat(32)) as Bytes32, blockNumber: 10 })
      );
      txn.insertSubmitted(
        submittedRow({ txHash: ('0x' + '02'.repeat(32)) as Bytes32, blockNumber: 20 })
      );
      txn.insertSubmitted(
        submittedRow({
          txHash: ('0x' + '03'.repeat(32)) as Bytes32,
          contentTag: TAG_B,
          blockNumber: 30,
        })
      );
    });
    const a = await store.withTxn((txn) =>
      Promise.resolve(txn.listSubmitted({ contentTag: TAG_A }))
    );
    expect(a.length).toBe(2);
    const since = await store.withTxn((txn) =>
      Promise.resolve(txn.listSubmitted({ contentTag: TAG_A, sinceBlock: 15n }))
    );
    expect(since.length).toBe(1);
    expect(since[0].blockNumber).toBe(20);
  });

  it('updateSubmittedStatus flips reorged status and sets invalidatedAt', async () => {
    const store = createMemoryStore();
    const row = submittedRow();
    await store.withTxn(async (txn) => txn.insertSubmitted(row));
    await store.withTxn(async (txn) =>
      txn.updateSubmittedStatus(row.txHash, 'reorged', null, null, 9_999)
    );
    const back = await store.withTxn((txn) =>
      Promise.resolve(txn.getSubmittedByTx(row.txHash))
    );
    expect(back!.status).toBe('reorged');
    expect(back!.invalidatedAt).toBe(9_999);
  });

  it('updateSubmittedStatus preserves non-null blockNumber when a null is passed', async () => {
    const store = createMemoryStore();
    const row = submittedRow({ blockNumber: 100 });
    await store.withTxn(async (txn) => txn.insertSubmitted(row));
    await store.withTxn(async (txn) =>
      txn.updateSubmittedStatus(row.txHash, 'reorged', null, null)
    );
    const back = await store.withTxn((txn) =>
      Promise.resolve(txn.getSubmittedByTx(row.txHash))
    );
    expect(back!.blockNumber).toBe(100);
  });
});

describe('MemoryBamStore — transaction rollback', () => {
  it('throws inside withTxn roll back pending inserts', async () => {
    const store = createMemoryStore();
    await store.withTxn(async (txn) => {
      txn.insertPending(pendingRow({ nonce: 1n, ingestSeq: 1 }));
    });

    await expect(
      store.withTxn(async (txn) => {
        txn.insertPending(pendingRow({ nonce: 2n, ingestSeq: 2 }));
        throw new Error('simulated failure');
      })
    ).rejects.toThrow();

    const rows = await store.withTxn((txn) =>
      Promise.resolve(txn.listPendingByTag(TAG_A))
    );
    expect(rows.map((r) => Number(r.nonce))).toEqual([1]); // nonce=2 rolled back
  });

  it('rollback restores nonce tracker state', async () => {
    const store = createMemoryStore();
    await store.withTxn(async (txn) =>
      txn.setNonce({
        sender: ADDR_1,
        lastNonce: 1n,
        lastMessageHash: ('0x' + 'aa'.repeat(32)) as Bytes32,
      })
    );
    await expect(
      store.withTxn(async (txn) => {
        txn.setNonce({
          sender: ADDR_1,
          lastNonce: 999n,
          lastMessageHash: ('0x' + 'bb'.repeat(32)) as Bytes32,
        });
        throw new Error('simulated failure');
      })
    ).rejects.toThrow();
    const back = await store.withTxn((txn) =>
      Promise.resolve(txn.getNonce(ADDR_1))
    );
    expect(back!.lastNonce).toBe(1n);
  });

  it('serializes concurrent withTxn callers', async () => {
    const store = createMemoryStore();
    const steps: number[] = [];
    const p1 = store.withTxn(async () => {
      steps.push(1);
      await new Promise((r) => setTimeout(r, 20));
      steps.push(2);
    });
    const p2 = store.withTxn(async () => {
      steps.push(3);
      steps.push(4);
    });
    await Promise.all([p1, p2]);
    // First txn must complete its [1,2] before the second runs.
    expect(steps).toEqual([1, 2, 3, 4]);
  });
});

describe('MemoryBamStore — signature returned by clonePending', () => {
  it('caller mutating returned bytes does not corrupt the store', async () => {
    const store = new MemoryBamStore();
    await store.withTxn(async (txn) => txn.insertPending(pendingRow()));
    const first = await store.withTxn((txn) =>
      Promise.resolve(txn.getPendingByKey({ sender: ADDR_1, nonce: 1n }))
    );
    first!.contents[0] = 0xff;
    const second = await store.withTxn((txn) =>
      Promise.resolve(txn.getPendingByKey({ sender: ADDR_1, nonce: 1n }))
    );
    expect(second!.contents[0]).toBe(0xaa);
  });
});
