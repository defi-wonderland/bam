import { describe, expect, it } from 'vitest';
import type { Address, Bytes32 } from 'bam-sdk';

import { checkMonotonicity } from '../../src/ingest/monotonicity.js';
import { createMemoryStore } from 'bam-store';
import type { BamStore } from 'bam-store';

const ADDR = ('0x' + '11'.repeat(20)) as Address;
const H1 = ('0x' + '11'.repeat(32)) as Bytes32;
const H2 = ('0x' + '22'.repeat(32)) as Bytes32;

async function seedLastAccepted(
  store: BamStore,
  nonce: bigint,
  hash: Bytes32
): Promise<void> {
  await store.withTxn(async (txn) =>
    txn.setNonce({ sender: ADDR, lastNonce: nonce, lastMessageHash: hash })
  );
}

describe('checkMonotonicity (ERC-8180 §Nonce Semantics)', () => {
  it('no last-accepted record → accept', async () => {
    const store = await createMemoryStore();
    const result = await store.withTxn(async (txn) =>
      checkMonotonicity(ADDR, 1n, H1, txn)
    );
    expect(result.decision).toBe('accept');
  });

  it('fresh nonce > last → accept', async () => {
    const store = await createMemoryStore();
    await seedLastAccepted(store, 5n, H1);
    const result = await store.withTxn(async (txn) =>
      checkMonotonicity(ADDR, 6n, H2, txn)
    );
    expect(result.decision).toBe('accept');
  });

  it('strictly lower nonce → reject stale_nonce', async () => {
    const store = await createMemoryStore();
    await seedLastAccepted(store, 5n, H1);
    const result = await store.withTxn(async (txn) =>
      checkMonotonicity(ADDR, 4n, H2, txn)
    );
    expect(result.decision).toBe('reject');
    if (result.decision === 'reject') expect(result.reason).toBe('stale_nonce');
  });

  it('equal nonce + byte-equal hash → no_op (retry tolerance)', async () => {
    const store = await createMemoryStore();
    await seedLastAccepted(store, 5n, H1);
    const result = await store.withTxn(async (txn) =>
      checkMonotonicity(ADDR, 5n, H1, txn)
    );
    expect(result.decision).toBe('no_op');
    if (result.decision === 'no_op')
      expect(result.existingMessageHash.toLowerCase()).toBe(H1.toLowerCase());
  });

  it('equal nonce but DIFFERENT hash → reject stale_nonce (collision)', async () => {
    const store = await createMemoryStore();
    await seedLastAccepted(store, 5n, H1);
    const result = await store.withTxn(async (txn) =>
      checkMonotonicity(ADDR, 5n, H2, txn)
    );
    expect(result.decision).toBe('reject');
    if (result.decision === 'reject') expect(result.reason).toBe('stale_nonce');
  });

  it('case-insensitive hash equality for the no-op branch', async () => {
    const store = await createMemoryStore();
    const lower = ('0x' + 'ab'.repeat(32)) as Bytes32;
    const upper = ('0x' + 'AB'.repeat(32)) as Bytes32;
    await seedLastAccepted(store, 5n, lower);
    const result = await store.withTxn(async (txn) =>
      checkMonotonicity(ADDR, 5n, upper, txn)
    );
    expect(result.decision).toBe('no_op');
  });

  describe('lazy fill from messages when nonces is empty', () => {
    // Reproduces the cold-DB-with-Reader-history scenario: Poster's
    // `nonces` tracker is empty (fresh deploy) but the `messages`
    // table is populated by a Reader backfill. Without lazy fill the
    // monotonicity check would green-light `nonce = 0` and the later
    // `insertPending` would collide on `(sender, nonce)`.
    async function seedConfirmedMessage(
      store: BamStore,
      nonce: bigint,
      hash: Bytes32,
      status: 'confirmed' | 'reorged' = 'confirmed'
    ): Promise<void> {
      await store.withTxn(async (txn) => {
        await txn.upsertBatch({
          chainId: 1,
          txHash: ('0x' + '01'.repeat(32)) as Bytes32,
          contentTag: ('0x' + 'aa'.repeat(32)) as Bytes32,
          blobVersionedHash: ('0x' + '03'.repeat(32)) as Bytes32,
          batchContentHash: ('0x' + '04'.repeat(32)) as Bytes32,
          blockNumber: 10,
          txIndex: 0,
          status: 'confirmed',
          replacedByTxHash: null,
          submittedAt: null,
          invalidatedAt: null,
          messageSnapshot: [],
          submitter: null,
          l1IncludedAtUnixSec: null,
        });
        await txn.upsertObserved({
          messageId: null,
          sender: ADDR,
          nonce,
          contentTag: ('0x' + 'aa'.repeat(32)) as Bytes32,
          contents: new Uint8Array(40),
          signature: new Uint8Array(65),
          messageHash: hash,
          status,
          batchRef: ('0x' + '01'.repeat(32)) as Bytes32,
          chainId: 1,
          ingestedAt: null,
          ingestSeq: null,
          blockNumber: 10,
          txIndex: 0,
          messageIndexWithinBatch: Number(nonce),
        });
      });
    }

    it('reconciles from messages.max(nonce) and rejects a lower nonce', async () => {
      const store = await createMemoryStore();
      await seedConfirmedMessage(store, 5n, H1);
      const result = await store.withTxn(async (txn) =>
        checkMonotonicity(ADDR, 5n, H2, txn)
      );
      // 5 ≤ 5 with mismatched hash → stale_nonce, not accept.
      expect(result.decision).toBe('reject');
      if (result.decision === 'reject')
        expect(result.reason).toBe('stale_nonce');
    });

    it('cache-fills nonces so the next call hits the fast path', async () => {
      const store = await createMemoryStore();
      await seedConfirmedMessage(store, 5n, H1);
      await store.withTxn(async (txn) => checkMonotonicity(ADDR, 6n, H2, txn));
      // After the lazy fill, getNonce alone must return the seeded row.
      const cached = await store.withTxn(async (txn) => txn.getNonce(ADDR));
      expect(cached).not.toBeNull();
      expect(cached!.lastNonce).toBe(5n);
      expect(cached!.lastMessageHash.toLowerCase()).toBe(H1.toLowerCase());
    });

    it('reorged messages do not seed the tracker', async () => {
      const store = await createMemoryStore();
      // The slot at nonce 5 is reorged — it's reclaimable, so the lazy
      // fill must not treat it as a covering record.
      await seedConfirmedMessage(store, 5n, H1, 'reorged');
      const result = await store.withTxn(async (txn) =>
        checkMonotonicity(ADDR, 0n, H2, txn)
      );
      expect(result.decision).toBe('accept');
    });

    it('is skipped entirely when the nonces row already exists', async () => {
      // Pins the fast path: even if `messages` has a *higher* nonce
      // than `nonces.last_nonce`, the lazy fill MUST NOT consult
      // `messages` when `getNonce` already returned a row. The tracker
      // is the source of truth once it has been populated; a refactor
      // that moves the fallback out of the `if (row === null)` guard
      // would silently start preferring `messages` data and corrupt
      // the per-sender sequencing this check exists to enforce.
      const store = await createMemoryStore();
      await seedConfirmedMessage(store, 9n, H1);
      // Backdoor the tracker to a lower value than messages claims.
      await store.withTxn((txn) =>
        txn.setNonce({ sender: ADDR, lastNonce: 3n, lastMessageHash: H1 })
      );
      const result = await store.withTxn(async (txn) =>
        checkMonotonicity(ADDR, 4n, H2, txn)
      );
      // If lazy fill had fired, last=9 and nonce=4 would have rejected
      // as stale_nonce. Acceptance proves the check used `nonces`.
      expect(result.decision).toBe('accept');
      // Tracker is untouched — lazy fill did not run.
      const after = await store.withTxn((txn) => txn.getNonce(ADDR));
      expect(after!.lastNonce).toBe(3n);
    });
  });
});
