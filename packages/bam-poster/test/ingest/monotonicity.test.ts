import { describe, expect, it } from 'vitest';
import type { Address, Bytes32 } from 'bam-sdk';

import { checkMonotonicity } from '../../src/ingest/monotonicity.js';
import { createMemoryStore } from 'bam-store';

const ADDR = ('0x' + '11'.repeat(20)) as Address;
const H1 = ('0x' + '11'.repeat(32)) as Bytes32;
const H2 = ('0x' + '22'.repeat(32)) as Bytes32;

async function seedLastAccepted(
  store: ReturnType<typeof createMemoryStore>,
  nonce: bigint,
  hash: Bytes32
): Promise<void> {
  await store.withTxn(async (txn) =>
    txn.setNonce({ sender: ADDR, lastNonce: nonce, lastMessageHash: hash })
  );
}

describe('checkMonotonicity (ERC-8180 §Nonce Semantics)', () => {
  it('no last-accepted record → accept', async () => {
    const store = createMemoryStore();
    const result = await store.withTxn(async (txn) =>
      checkMonotonicity(ADDR, 1n, H1, txn)
    );
    expect(result.decision).toBe('accept');
  });

  it('fresh nonce > last → accept', async () => {
    const store = createMemoryStore();
    await seedLastAccepted(store, 5n, H1);
    const result = await store.withTxn(async (txn) =>
      checkMonotonicity(ADDR, 6n, H2, txn)
    );
    expect(result.decision).toBe('accept');
  });

  it('strictly lower nonce → reject stale_nonce', async () => {
    const store = createMemoryStore();
    await seedLastAccepted(store, 5n, H1);
    const result = await store.withTxn(async (txn) =>
      checkMonotonicity(ADDR, 4n, H2, txn)
    );
    expect(result.decision).toBe('reject');
    if (result.decision === 'reject') expect(result.reason).toBe('stale_nonce');
  });

  it('equal nonce + byte-equal hash → no_op (retry tolerance)', async () => {
    const store = createMemoryStore();
    await seedLastAccepted(store, 5n, H1);
    const result = await store.withTxn(async (txn) =>
      checkMonotonicity(ADDR, 5n, H1, txn)
    );
    expect(result.decision).toBe('no_op');
    if (result.decision === 'no_op')
      expect(result.existingMessageHash.toLowerCase()).toBe(H1.toLowerCase());
  });

  it('equal nonce but DIFFERENT hash → reject stale_nonce (collision)', async () => {
    const store = createMemoryStore();
    await seedLastAccepted(store, 5n, H1);
    const result = await store.withTxn(async (txn) =>
      checkMonotonicity(ADDR, 5n, H2, txn)
    );
    expect(result.decision).toBe('reject');
    if (result.decision === 'reject') expect(result.reason).toBe('stale_nonce');
  });

  it('case-insensitive hash equality for the no-op branch', async () => {
    const store = createMemoryStore();
    const lower = ('0x' + 'ab'.repeat(32)) as Bytes32;
    const upper = ('0x' + 'AB'.repeat(32)) as Bytes32;
    await seedLastAccepted(store, 5n, lower);
    const result = await store.withTxn(async (txn) =>
      checkMonotonicity(ADDR, 5n, upper, txn)
    );
    expect(result.decision).toBe('no_op');
  });
});
