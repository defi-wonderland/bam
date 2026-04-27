import { createMemoryStore } from 'bam-store';
import { describe, expect, it } from 'vitest';

import { commitBlock, getCursor } from '../../src/discovery/cursor.js';

const CHAIN_ID = 11155111;

describe('commitBlock', () => {
  it('advances the cursor only after writes succeed', async () => {
    const store = createMemoryStore();
    const observed: string[] = [];
    await commitBlock(store, {
      chainId: CHAIN_ID,
      blockNumber: 100,
      lastTxIndex: 3,
      writes: async () => {
        observed.push('writes-ran');
      },
      now: () => 1234,
    });
    expect(observed).toEqual(['writes-ran']);
    const cursor = await getCursor(store, CHAIN_ID);
    expect(cursor).toEqual({
      chainId: CHAIN_ID,
      lastBlockNumber: 100,
      lastTxIndex: 3,
      updatedAt: 1234,
    });
  });

  it('does not advance the cursor when writes throw', async () => {
    const store = createMemoryStore();
    await expect(
      commitBlock(store, {
        chainId: CHAIN_ID,
        blockNumber: 200,
        lastTxIndex: 1,
        writes: async () => {
          throw new Error('boom');
        },
      })
    ).rejects.toThrow('boom');
    const cursor = await getCursor(store, CHAIN_ID);
    expect(cursor).toBeNull();
  });

  it('preserves the prior cursor when a later block fails mid-write', async () => {
    const store = createMemoryStore();
    await commitBlock(store, {
      chainId: CHAIN_ID,
      blockNumber: 100,
      lastTxIndex: 0,
      writes: async () => {},
      now: () => 1,
    });
    await expect(
      commitBlock(store, {
        chainId: CHAIN_ID,
        blockNumber: 101,
        lastTxIndex: 0,
        writes: async () => {
          throw new Error('mid-block');
        },
      })
    ).rejects.toThrow('mid-block');
    const cursor = await getCursor(store, CHAIN_ID);
    expect(cursor?.lastBlockNumber).toBe(100);
  });

  it('passes the same StoreTxn to writes that setCursor uses', async () => {
    const store = createMemoryStore();
    const seen: unknown[] = [];
    await commitBlock(store, {
      chainId: CHAIN_ID,
      blockNumber: 50,
      lastTxIndex: 0,
      writes: async (txn) => {
        seen.push(txn);
        // Issue a write that uses the same txn — proves boundary preserved.
        await txn.setCursor({
          chainId: CHAIN_ID,
          lastBlockNumber: 49,
          lastTxIndex: 99,
          updatedAt: 0,
        });
      },
    });
    // commitBlock's setCursor wins (last-write-wins inside the txn).
    const cursor = await getCursor(store, CHAIN_ID);
    expect(cursor?.lastBlockNumber).toBe(50);
    expect(cursor?.lastTxIndex).toBe(0);
    expect(seen.length).toBe(1);
  });
});
