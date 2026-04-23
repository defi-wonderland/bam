import { describe, it, expect } from 'vitest';
import type { Address, Bytes32 } from 'bam-sdk';

import { checkMonotonicity } from '../../src/ingest/monotonicity.js';
import { MemoryPosterStore } from '../../src/pool/memory-store.js';

const AUTHOR = '0x1234567890123456789012345678901234567890' as Address;
const MSG_A = ('0x' + 'aa'.repeat(32)) as Bytes32;
const MSG_B = ('0x' + 'bb'.repeat(32)) as Bytes32;

describe('checkMonotonicity', () => {
  it('accepts the very first message for an unseen author', async () => {
    const store = new MemoryPosterStore();
    await store.withTxn(async (txn) => {
      const out = await checkMonotonicity(AUTHOR, 1n, MSG_A, txn);
      expect(out).toEqual({ decision: 'accept' });
    });
  });

  it('accepts a strictly greater nonce', async () => {
    const store = new MemoryPosterStore();
    await store.withTxn(async (txn) => {
      await txn.setNonce({ author: AUTHOR, lastNonce: 5n, lastMessageId: MSG_A });
      const out = await checkMonotonicity(AUTHOR, 6n, MSG_B, txn);
      expect(out).toEqual({ decision: 'accept' });
    });
  });

  it('treats an equal-nonce byte-equal resubmit as a no-op (returns the existing id)', async () => {
    const store = new MemoryPosterStore();
    await store.withTxn(async (txn) => {
      await txn.setNonce({ author: AUTHOR, lastNonce: 5n, lastMessageId: MSG_A });
      const out = await checkMonotonicity(AUTHOR, 5n, MSG_A, txn);
      expect(out).toEqual({ decision: 'no_op', existingMessageId: MSG_A });
    });
  });

  it('rejects equal-nonce with different contents as stale_nonce', async () => {
    const store = new MemoryPosterStore();
    await store.withTxn(async (txn) => {
      await txn.setNonce({ author: AUTHOR, lastNonce: 5n, lastMessageId: MSG_A });
      const out = await checkMonotonicity(AUTHOR, 5n, MSG_B, txn);
      expect(out).toEqual({ decision: 'reject', reason: 'stale_nonce' });
    });
  });

  it('rejects strictly-lesser nonce as stale_nonce', async () => {
    const store = new MemoryPosterStore();
    await store.withTxn(async (txn) => {
      await txn.setNonce({ author: AUTHOR, lastNonce: 5n, lastMessageId: MSG_A });
      const out = await checkMonotonicity(AUTHOR, 4n, MSG_B, txn);
      expect(out).toEqual({ decision: 'reject', reason: 'stale_nonce' });
    });
  });

  it('is case-insensitive comparing messageId on the byte-equal-retry path', async () => {
    const store = new MemoryPosterStore();
    const lower = ('0x' + 'a'.repeat(64)) as Bytes32;
    const upper = ('0x' + 'A'.repeat(64)) as Bytes32;
    await store.withTxn(async (txn) => {
      await txn.setNonce({ author: AUTHOR, lastNonce: 1n, lastMessageId: lower });
      const out = await checkMonotonicity(AUTHOR, 1n, upper, txn);
      expect(out.decision).toBe('no_op');
    });
  });
});
