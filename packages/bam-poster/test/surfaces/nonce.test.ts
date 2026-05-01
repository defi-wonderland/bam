import { describe, expect, it } from 'vitest';
import { createMemoryStore } from 'bam-store';
import type { Address, Bytes32 } from 'bam-sdk';

import { getNextNonce } from '../../src/surfaces/nonce.js';

const HASH = ('0x' + '77'.repeat(32)) as Bytes32;
const SENDER_A = ('0x' + '11'.repeat(20)) as Address;
const SENDER_B = ('0x' + '22'.repeat(20)) as Address;

describe('getNextNonce', () => {
  it('returns 0n for a sender with no nonce tracker row', async () => {
    const store = await createMemoryStore();
    try {
      const next = await getNextNonce(store, SENDER_A);
      expect(next).toBe(0n);
    } finally {
      await store.close();
    }
  });

  it('returns lastNonce + 1n when a tracker row exists', async () => {
    const store = await createMemoryStore();
    try {
      await store.withTxn((txn) =>
        txn.setNonce({ sender: SENDER_A, lastNonce: 7n, lastMessageHash: HASH })
      );
      const next = await getNextNonce(store, SENDER_A);
      expect(next).toBe(8n);
    } finally {
      await store.close();
    }
  });

  it('is keyed per-sender — does not leak across senders', async () => {
    const store = await createMemoryStore();
    try {
      await store.withTxn(async (txn) => {
        await txn.setNonce({ sender: SENDER_A, lastNonce: 99n, lastMessageHash: HASH });
      });
      expect(await getNextNonce(store, SENDER_A)).toBe(100n);
      expect(await getNextNonce(store, SENDER_B)).toBe(0n);
    } finally {
      await store.close();
    }
  });

  it('handles uint64 boundary values without precision loss', async () => {
    const store = await createMemoryStore();
    try {
      const big = (1n << 63n) + 1n;
      await store.withTxn((txn) =>
        txn.setNonce({ sender: SENDER_A, lastNonce: big, lastMessageHash: HASH })
      );
      const next = await getNextNonce(store, SENDER_A);
      expect(next).toBe(big + 1n);
    } finally {
      await store.close();
    }
  });
});
