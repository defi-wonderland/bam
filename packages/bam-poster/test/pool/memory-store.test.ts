import { describe, it, expect } from 'vitest';
import type { Address, Bytes32 } from 'bam-sdk';

import { MemoryPosterStore } from '../../src/pool/memory-store.js';
import type { StoreTxnPendingRow, StoreTxnSubmittedRow } from '../../src/types.js';

const TAG_A = ('0x' + 'aa'.repeat(32)) as Bytes32;
const TAG_B = ('0x' + 'bb'.repeat(32)) as Bytes32;
const AUTHOR = '0x1234567890123456789012345678901234567890' as Address;
const AUTHOR_2 = '0x2222222222222222222222222222222222222222' as Address;

function makePending(overrides: Partial<StoreTxnPendingRow> = {}): StoreTxnPendingRow {
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

function makeSubmitted(overrides: Partial<StoreTxnSubmittedRow> = {}): StoreTxnSubmittedRow {
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

describe('MemoryPosterStore — pending CRUD', () => {
  it('inserts + reads a pending row', async () => {
    const store = new MemoryPosterStore();
    const row = makePending();
    await store.withTxn(async (txn) => {
      await txn.insertPending(row);
    });
    const back = await store.withTxn(async (txn) => txn.getPendingByMessageId(row.messageId));
    expect(back).not.toBeNull();
    expect(back!.author).toBe(AUTHOR);
    expect(back!.nonce).toBe(1n);
  });

  it('rejects duplicate message_id inserts', async () => {
    const store = new MemoryPosterStore();
    const row = makePending();
    await store.withTxn(async (txn) => {
      await txn.insertPending(row);
    });
    await expect(
      store.withTxn(async (txn) => {
        await txn.insertPending(row);
      })
    ).rejects.toThrow(/duplicate message_id/);
  });

  it('lists pending per tag in FIFO (ingest_seq) order and respects limit / sinceSeq', async () => {
    const store = new MemoryPosterStore();
    await store.withTxn(async (txn) => {
      for (let i = 1; i <= 5; i++) {
        const seq = await txn.nextIngestSeq(TAG_A);
        await txn.insertPending(
          makePending({
            messageId: (`0x${i.toString(16).padStart(64, '0')}`) as Bytes32,
            ingestSeq: seq,
          })
        );
      }
      // Tag B should not show up in Tag A listing.
      const seqB = await txn.nextIngestSeq(TAG_B);
      await txn.insertPending(
        makePending({
          messageId: ('0xb' + 'b'.repeat(63)) as Bytes32,
          contentTag: TAG_B,
          ingestSeq: seqB,
        })
      );
    });

    const allA = await store.withTxn(async (txn) => txn.listPendingByTag(TAG_A));
    expect(allA.map((r) => r.ingestSeq)).toEqual([1, 2, 3, 4, 5]);

    const limited = await store.withTxn(async (txn) => txn.listPendingByTag(TAG_A, 2));
    expect(limited.map((r) => r.ingestSeq)).toEqual([1, 2]);

    const after = await store.withTxn(async (txn) => txn.listPendingByTag(TAG_A, undefined, 3));
    expect(after.map((r) => r.ingestSeq)).toEqual([4, 5]);
  });

  it('listPendingAll returns every pending row, regardless of tag', async () => {
    const store = new MemoryPosterStore();
    await store.withTxn(async (txn) => {
      await txn.insertPending(
        makePending({
          messageId: ('0xa' + '0'.repeat(63)) as Bytes32,
          ingestSeq: await txn.nextIngestSeq(TAG_A),
        })
      );
      await txn.insertPending(
        makePending({
          messageId: ('0xb' + '0'.repeat(63)) as Bytes32,
          contentTag: TAG_B,
          ingestSeq: await txn.nextIngestSeq(TAG_B),
          ingestedAt: 1_700_000_000_001,
        })
      );
    });
    const all = await store.withTxn(async (txn) => txn.listPendingAll());
    expect(all).toHaveLength(2);
    expect(all.map((r) => r.contentTag).sort()).toEqual([TAG_A, TAG_B].sort());
  });

  it('deletePending removes rows by id and countPendingByTag reflects the delete', async () => {
    const store = new MemoryPosterStore();
    const a = makePending({
      messageId: ('0xa' + 'a'.repeat(63)) as Bytes32,
      ingestSeq: 1,
    });
    const b = makePending({
      messageId: ('0xb' + 'b'.repeat(63)) as Bytes32,
      ingestSeq: 2,
    });
    await store.withTxn(async (txn) => {
      await txn.insertPending(a);
      await txn.insertPending(b);
      expect(await txn.countPendingByTag(TAG_A)).toBe(2);
      await txn.deletePending([a.messageId]);
      expect(await txn.countPendingByTag(TAG_A)).toBe(1);
    });
  });

  it('nextIngestSeq is per-tag and strictly increasing', async () => {
    const store = new MemoryPosterStore();
    await store.withTxn(async (txn) => {
      expect(await txn.nextIngestSeq(TAG_A)).toBe(1);
      expect(await txn.nextIngestSeq(TAG_A)).toBe(2);
      expect(await txn.nextIngestSeq(TAG_B)).toBe(1);
      expect(await txn.nextIngestSeq(TAG_A)).toBe(3);
    });
  });
});

describe('MemoryPosterStore — nonce tracker', () => {
  it('round-trips get/set by author', async () => {
    const store = new MemoryPosterStore();
    await store.withTxn(async (txn) => {
      expect(await txn.getNonce(AUTHOR)).toBeNull();
      await txn.setNonce({
        author: AUTHOR,
        lastNonce: 42n,
        lastMessageId: ('0x' + '11'.repeat(32)) as Bytes32,
      });
      const row = await txn.getNonce(AUTHOR);
      expect(row).toEqual({
        author: AUTHOR,
        lastNonce: 42n,
        lastMessageId: ('0x' + '11'.repeat(32)) as Bytes32,
      });
    });
  });

  it('scopes state per author', async () => {
    const store = new MemoryPosterStore();
    await store.withTxn(async (txn) => {
      await txn.setNonce({
        author: AUTHOR,
        lastNonce: 1n,
        lastMessageId: ('0x' + '01'.repeat(32)) as Bytes32,
      });
      await txn.setNonce({
        author: AUTHOR_2,
        lastNonce: 99n,
        lastMessageId: ('0x' + '02'.repeat(32)) as Bytes32,
      });
      expect((await txn.getNonce(AUTHOR))!.lastNonce).toBe(1n);
      expect((await txn.getNonce(AUTHOR_2))!.lastNonce).toBe(99n);
    });
  });

  it('is case-insensitive on the author key (FU-6: parity with sqlite)', async () => {
    const store = new MemoryPosterStore();
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
    expect(back!.author).toBe(lower);
  });
});

describe('MemoryPosterStore — submitted-batches CRUD', () => {
  it('inserts + reads a submitted row', async () => {
    const store = new MemoryPosterStore();
    const row = makeSubmitted();
    await store.withTxn(async (txn) => {
      await txn.insertSubmitted(row);
    });
    const back = await store.withTxn(async (txn) => txn.getSubmittedByTx(row.txHash));
    expect(back).not.toBeNull();
    expect(back!.status).toBe('included');
    expect(back!.messageIds).toHaveLength(1);
  });

  it('filters listSubmitted by contentTag and sinceBlock', async () => {
    const store = new MemoryPosterStore();
    await store.withTxn(async (txn) => {
      await txn.insertSubmitted(
        makeSubmitted({ txHash: ('0x' + '11'.repeat(32)) as Bytes32, blockNumber: 10 })
      );
      await txn.insertSubmitted(
        makeSubmitted({ txHash: ('0x' + '22'.repeat(32)) as Bytes32, blockNumber: 20 })
      );
      await txn.insertSubmitted(
        makeSubmitted({
          txHash: ('0x' + '33'.repeat(32)) as Bytes32,
          contentTag: TAG_B,
          blockNumber: 30,
        })
      );
    });

    const byTag = await store.withTxn(async (txn) =>
      txn.listSubmitted({ contentTag: TAG_B })
    );
    expect(byTag.map((r) => r.blockNumber)).toEqual([30]);

    const sinceBlock = await store.withTxn(async (txn) =>
      txn.listSubmitted({ sinceBlock: 20n })
    );
    expect(sinceBlock.map((r) => r.blockNumber).sort()).toEqual([20, 30]);
  });

  it('updates status + replacedByTxHash', async () => {
    const store = new MemoryPosterStore();
    const orig = makeSubmitted({ txHash: ('0x' + '11'.repeat(32)) as Bytes32 });
    const replacement = ('0x' + '99'.repeat(32)) as Bytes32;
    await store.withTxn(async (txn) => {
      await txn.insertSubmitted(orig);
      await txn.updateSubmittedStatus(orig.txHash, 'reorged', replacement, null);
    });
    const back = await store.withTxn(async (txn) => txn.getSubmittedByTx(orig.txHash));
    expect(back!.status).toBe('reorged');
    expect(back!.replacedByTxHash).toBe(replacement);
  });
});

describe('MemoryPosterStore — withTxn serialization', () => {
  it('serializes concurrent withTxn callers through the async lock', async () => {
    const store = new MemoryPosterStore();
    const order: number[] = [];
    const deferred = <T>(): { promise: Promise<T>; resolve: (v: T) => void } => {
      let resolve!: (v: T) => void;
      const promise = new Promise<T>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    };

    const a = deferred<void>();
    const b = deferred<void>();

    const p1 = store.withTxn(async () => {
      order.push(1);
      await a.promise;
      order.push(2);
    });
    const p2 = store.withTxn(async () => {
      order.push(3);
      await b.promise;
      order.push(4);
    });

    // p2 must not have started until p1 is done.
    await Promise.resolve();
    expect(order).toEqual([1]);
    a.resolve();
    await p1;
    expect(order).toEqual([1, 2, 3]);
    b.resolve();
    await p2;
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it('recovers from a failed txn so subsequent acquirers still run', async () => {
    const store = new MemoryPosterStore();
    const failing = store
      .withTxn(async () => {
        throw new Error('boom');
      })
      .catch(() => 'caught');
    expect(await failing).toBe('caught');
    const res = await store.withTxn(async () => 'ok');
    expect(res).toBe('ok');
  });
});
