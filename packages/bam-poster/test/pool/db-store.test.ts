import { describe, it, expect, afterEach } from 'vitest';
import type { Address, Bytes32 } from 'bam-sdk';

import { SqlitePosterStore } from '../../src/pool/sqlite.js';
import { createDbStore } from '../../src/pool/db-store.js';
import type { StoreTxnPendingRow, StoreTxnSubmittedRow } from '../../src/types.js';

const TAG_A = ('0x' + 'aa'.repeat(32)) as Bytes32;
const TAG_B = ('0x' + 'bb'.repeat(32)) as Bytes32;
const AUTHOR = '0x1234567890123456789012345678901234567890' as Address;
const AUTHOR_2 = '0x2222222222222222222222222222222222222222' as Address;

function pending(overrides: Partial<StoreTxnPendingRow> = {}): StoreTxnPendingRow {
  return {
    messageId: ('0x' + '11'.repeat(32)) as Bytes32,
    contentTag: TAG_A,
    author: AUTHOR,
    nonce: 1n,
    timestamp: 1_700_000_000,
    content: new Uint8Array([1, 2, 3]),
    signature: new Uint8Array(65),
    ingestedAt: 1_700_000_000_000,
    ingestSeq: 1,
    ...overrides,
  };
}

function submitted(overrides: Partial<StoreTxnSubmittedRow> = {}): StoreTxnSubmittedRow {
  return {
    txHash: ('0x' + 'cc'.repeat(32)) as Bytes32,
    contentTag: TAG_A,
    blobVersionedHash: ('0x' + 'dd'.repeat(32)) as Bytes32,
    blockNumber: 100,
    status: 'included',
    replacedByTxHash: null,
    submittedAt: 1_700_000_000_000,
    messageIds: [('0x' + '11'.repeat(32)) as Bytes32],
    messages: [],
    ...overrides,
  };
}

describe('SqlitePosterStore — pending CRUD', () => {
  let store: SqlitePosterStore;
  afterEach(async () => {
    await store.close();
  });

  it('inserts + reads a pending row (byte-preserving content + signature)', async () => {
    store = new SqlitePosterStore(':memory:');
    const content = new Uint8Array([9, 8, 7, 6, 5]);
    const sig = new Uint8Array(65);
    sig[0] = 0xde;
    sig[64] = 0xad;
    await store.withTxn(async (txn) => {
      await txn.insertPending(pending({ content, signature: sig }));
    });
    const back = await store.withTxn(async (txn) =>
      txn.getPendingByMessageId(('0x' + '11'.repeat(32)) as Bytes32)
    );
    expect(back).not.toBeNull();
    expect(Array.from(back!.content)).toEqual([9, 8, 7, 6, 5]);
    expect(back!.signature[0]).toBe(0xde);
    expect(back!.signature[64]).toBe(0xad);
  });

  it('enforces PRIMARY KEY on message_id', async () => {
    store = new SqlitePosterStore(':memory:');
    await store.withTxn(async (txn) => {
      await txn.insertPending(pending());
    });
    await expect(
      store.withTxn(async (txn) => {
        await txn.insertPending(pending());
      })
    ).rejects.toThrow();
  });

  it('lists pending per tag in FIFO order; supports limit + sinceSeq', async () => {
    store = new SqlitePosterStore(':memory:');
    await store.withTxn(async (txn) => {
      for (let i = 1; i <= 4; i++) {
        await txn.insertPending(
          pending({
            messageId: (`0x${i.toString(16).padStart(64, '0')}`) as Bytes32,
            ingestSeq: i,
            ingestedAt: 1_700_000_000_000 + i,
          })
        );
      }
      // Cross-tag pollution
      await txn.insertPending(
        pending({
          messageId: ('0xff' + '0'.repeat(62)) as Bytes32,
          contentTag: TAG_B,
          ingestSeq: 1,
        })
      );
    });
    const rows = await store.withTxn(async (txn) => txn.listPendingByTag(TAG_A));
    expect(rows.map((r) => r.ingestSeq)).toEqual([1, 2, 3, 4]);
    expect(rows.every((r) => r.contentTag === TAG_A)).toBe(true);

    const limited = await store.withTxn(async (txn) => txn.listPendingByTag(TAG_A, 2));
    expect(limited).toHaveLength(2);

    const after2 = await store.withTxn(async (txn) => txn.listPendingByTag(TAG_A, undefined, 2));
    expect(after2.map((r) => r.ingestSeq)).toEqual([3, 4]);
  });

  it('deletePending + countPendingByTag', async () => {
    store = new SqlitePosterStore(':memory:');
    await store.withTxn(async (txn) => {
      await txn.insertPending(
        pending({ messageId: ('0x' + 'a1'.repeat(32)) as Bytes32, ingestSeq: 1 })
      );
      await txn.insertPending(
        pending({ messageId: ('0x' + 'a2'.repeat(32)) as Bytes32, ingestSeq: 2 })
      );
    });
    await store.withTxn(async (txn) => {
      expect(await txn.countPendingByTag(TAG_A)).toBe(2);
      await txn.deletePending([('0x' + 'a1'.repeat(32)) as Bytes32]);
      expect(await txn.countPendingByTag(TAG_A)).toBe(1);
    });
  });

  it('nextIngestSeq is 1 on empty pool, then strictly increasing per-tag', async () => {
    store = new SqlitePosterStore(':memory:');
    await store.withTxn(async (txn) => {
      expect(await txn.nextIngestSeq(TAG_A)).toBe(1);
    });
    await store.withTxn(async (txn) => {
      const seq = await txn.nextIngestSeq(TAG_A);
      await txn.insertPending(
        pending({ messageId: ('0x' + '01'.repeat(32)) as Bytes32, ingestSeq: seq })
      );
    });
    await store.withTxn(async (txn) => {
      expect(await txn.nextIngestSeq(TAG_A)).toBe(2);
      expect(await txn.nextIngestSeq(TAG_B)).toBe(1);
    });
  });
});

describe('SqlitePosterStore — nonce tracker', () => {
  let store: SqlitePosterStore;
  afterEach(async () => {
    await store.close();
  });

  it('round-trips the largest uint64 (2^64 - 1) through the codec', async () => {
    store = new SqlitePosterStore(':memory:');
    const MAX = (1n << 64n) - 1n;
    const mid = ('0x' + '42'.repeat(32)) as Bytes32;
    await store.withTxn(async (txn) => {
      await txn.setNonce({ author: AUTHOR, lastNonce: MAX, lastMessageId: mid });
    });
    const back = await store.withTxn(async (txn) => txn.getNonce(AUTHOR));
    expect(back).not.toBeNull();
    expect(back!.lastNonce).toBe(MAX);
    expect(back!.lastMessageId).toBe(mid);
  });

  it('UPSERT keeps one row per author', async () => {
    store = new SqlitePosterStore(':memory:');
    await store.withTxn(async (txn) => {
      await txn.setNonce({
        author: AUTHOR,
        lastNonce: 1n,
        lastMessageId: ('0x' + '01'.repeat(32)) as Bytes32,
      });
      await txn.setNonce({
        author: AUTHOR,
        lastNonce: 2n,
        lastMessageId: ('0x' + '02'.repeat(32)) as Bytes32,
      });
    });
    const back = await store.withTxn(async (txn) => txn.getNonce(AUTHOR));
    expect(back!.lastNonce).toBe(2n);
  });

  it('is case-insensitive for the author key', async () => {
    store = new SqlitePosterStore(':memory:');
    const upper = ('0x' + 'A'.repeat(40)) as Address;
    const lower = ('0x' + 'a'.repeat(40)) as Address;
    await store.withTxn(async (txn) => {
      await txn.setNonce({
        author: upper,
        lastNonce: 5n,
        lastMessageId: ('0x' + '05'.repeat(32)) as Bytes32,
      });
    });
    const back = await store.withTxn(async (txn) => txn.getNonce(lower));
    expect(back!.lastNonce).toBe(5n);
  });

  it('scopes by author', async () => {
    store = new SqlitePosterStore(':memory:');
    await store.withTxn(async (txn) => {
      await txn.setNonce({
        author: AUTHOR,
        lastNonce: 3n,
        lastMessageId: ('0x' + '03'.repeat(32)) as Bytes32,
      });
      await txn.setNonce({
        author: AUTHOR_2,
        lastNonce: 17n,
        lastMessageId: ('0x' + '17'.repeat(32)) as Bytes32,
      });
    });
    await store.withTxn(async (txn) => {
      expect((await txn.getNonce(AUTHOR))!.lastNonce).toBe(3n);
      expect((await txn.getNonce(AUTHOR_2))!.lastNonce).toBe(17n);
    });
  });
});

describe('SqlitePosterStore — submitted-batches CRUD', () => {
  let store: SqlitePosterStore;
  afterEach(async () => {
    await store.close();
  });

  it('inserts + reads + list filter + status update', async () => {
    store = new SqlitePosterStore(':memory:');
    const rowA = submitted({ txHash: ('0x' + '11'.repeat(32)) as Bytes32, blockNumber: 10 });
    const rowB = submitted({
      txHash: ('0x' + '22'.repeat(32)) as Bytes32,
      contentTag: TAG_B,
      blockNumber: 20,
    });
    await store.withTxn(async (txn) => {
      await txn.insertSubmitted(rowA);
      await txn.insertSubmitted(rowB);
    });

    const backA = await store.withTxn(async (txn) => txn.getSubmittedByTx(rowA.txHash));
    expect(backA!.messageIds).toEqual(rowA.messageIds);

    const onlyA = await store.withTxn(async (txn) => txn.listSubmitted({ contentTag: TAG_A }));
    expect(onlyA).toHaveLength(1);

    const sinceBlock = await store.withTxn(async (txn) =>
      txn.listSubmitted({ sinceBlock: 15n })
    );
    expect(sinceBlock.map((r) => r.blockNumber).sort()).toEqual([20]);

    const replacement = ('0x' + '99'.repeat(32)) as Bytes32;
    await store.withTxn(async (txn) => {
      await txn.updateSubmittedStatus(rowA.txHash, 'reorged', replacement, null);
    });
    const updated = await store.withTxn(async (txn) => txn.getSubmittedByTx(rowA.txHash));
    expect(updated!.status).toBe('reorged');
    expect(updated!.replacedByTxHash).toBe(replacement);
    expect(updated!.blockNumber).toBe(10); // unchanged when null supplied
  });

  it('updateSubmittedStatus can overwrite block_number when a non-null value is supplied', async () => {
    store = new SqlitePosterStore(':memory:');
    const row = submitted({ blockNumber: null, status: 'pending' });
    await store.withTxn(async (txn) => {
      await txn.insertSubmitted(row);
      await txn.updateSubmittedStatus(row.txHash, 'included', null, 7);
    });
    const back = await store.withTxn(async (txn) => txn.getSubmittedByTx(row.txHash));
    expect(back!.blockNumber).toBe(7);
    expect(back!.status).toBe('included');
  });
});

describe('SqlitePosterStore — restart survival', () => {
  it('persists pool + nonce + submitted state across reopens', async () => {
    const path = `/tmp/bam-poster-test-${process.pid}-${Date.now()}.db`;
    const a = new SqlitePosterStore(path);
    await a.withTxn(async (txn) => {
      await txn.insertPending(pending());
      await txn.setNonce({
        author: AUTHOR,
        lastNonce: 9n,
        lastMessageId: ('0x' + '09'.repeat(32)) as Bytes32,
      });
      await txn.insertSubmitted(submitted());
    });
    await a.close();

    const b = new SqlitePosterStore(path);
    const p = await b.withTxn(async (txn) =>
      txn.getPendingByMessageId(('0x' + '11'.repeat(32)) as Bytes32)
    );
    const n = await b.withTxn(async (txn) => txn.getNonce(AUTHOR));
    const s = await b.withTxn(async (txn) =>
      txn.getSubmittedByTx(('0x' + 'cc'.repeat(32)) as Bytes32)
    );
    expect(p).not.toBeNull();
    expect(n!.lastNonce).toBe(9n);
    expect(s!.blobVersionedHash).toBe('0x' + 'dd'.repeat(32));
    await b.close();
  });
});

describe('createDbStore dispatcher', () => {
  it('returns a SqlitePosterStore when POSTGRES_URL is absent', async () => {
    const store = createDbStore({ sqlitePath: ':memory:' });
    try {
      expect(store).toBeInstanceOf(SqlitePosterStore);
    } finally {
      await store.close();
    }
  });
});
