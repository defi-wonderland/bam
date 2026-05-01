/**
 * Integration test for the range-validation chokepoint (T014, C-2).
 *
 * Inject a malformed `BlobBatchRegisteredEvent` into the Reader's
 * processBatch chokepoint. Asserts:
 *   (a) no `BatchRow` is written
 *   (b) the `skippedRange` counter increments
 *   (c) a `range_rejected` log event is emitted with the rejection reason
 *   (d) processing of subsequent valid events continues without halting
 */

import type { Address, Bytes32 } from 'bam-sdk';
import { createMemoryStore } from 'bam-store';
import { describe, expect, it } from 'vitest';

import {
  emptyCounters,
  processBatch,
} from '../../src/loop/process-batch.js';
import type { BlobBatchRegisteredEvent } from '../../src/discovery/log-scan.js';
import type { ReaderEvent } from '../../src/types.js';

const CHAIN_ID = 11155111;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;
const SUBMITTER = '0x0000000000000000000000000000000000c0ffee' as Address;
const TAG = ('0x' + 'aa'.repeat(32)) as Bytes32;

function event(opts: { startFE?: number; endFE?: number }): BlobBatchRegisteredEvent {
  return {
    blockNumber: 100,
    txIndex: 0,
    logIndex: 0,
    txHash: ('0x' + 'aa'.repeat(32)) as Bytes32,
    versionedHash: ('0x' + '01' + '00'.repeat(31)) as Bytes32,
    submitter: SUBMITTER,
    contentTag: TAG,
    decoder: ZERO_ADDRESS,
    signatureRegistry: ZERO_ADDRESS,
    startFE: opts.startFE,
    endFE: opts.endFE,
  };
}

const FAKE_BLOB = new Uint8Array(4096 * 32);

describe('range-rejection chokepoint (integration)', () => {
  it('rejects an out-of-bounds endFE without writing any row', async () => {
    const store = await createMemoryStore();
    try {
      const counters = emptyCounters();
      const events: ReaderEvent[] = [];

      const result = await processBatch({
        // Malformed: endFE > FIELD_ELEMENTS_PER_BLOB.
        event: event({ startFE: 0, endFE: 10_000 }),
        parentBeaconBlockRoot: null,
        l1IncludedAtUnixSec: 1_700_000_000,
        store,
        sources: {},
        chainId: CHAIN_ID,
        ethCallGasCap: 50_000_000n,
        ethCallTimeoutMs: 5_000,
        counters,
        logger: (e) => events.push(e),
        // The fetch / decode / verify hooks must not run for a rejected
        // range — assert that by throwing if the loop reaches them.
        fetchBlob: async () => {
          throw new Error('fetchBlob must not be called for a malformed range');
        },
        decode: async () => {
          throw new Error('decode must not be called for a malformed range');
        },
        verifyMessage: async () => {
          throw new Error('verifyMessage must not be called for a malformed range');
        },
        now: () => 1_700_000_000_000,
        fetchImpl: async () => {
          throw new Error('fetchImpl must not be called for a malformed range');
        },
      });

      expect(result.outcome).toBe('range_rejected');
      expect(result.messagesWritten).toBe(0);
      expect(counters.skippedRange).toBe(1);
      expect(counters.decoded).toBe(0);

      // No BatchRow was written.
      const batches = await store.withTxn((txn) => txn.listBatches({}));
      expect(batches).toHaveLength(0);

      // A structured `range_rejected` event was emitted with the reason.
      const rejection = events.find((e) => e.kind === 'range_rejected');
      expect(rejection).toBeTruthy();
      if (rejection && rejection.kind === 'range_rejected') {
        expect(rejection.reason).toBe('endFE-exceeds-blob');
        expect(rejection.startFE).toBe(0);
        expect(rejection.endFE).toBe(10_000);
      }
    } finally {
      await store.close();
    }
  });

  it('continues processing valid events after a rejected one', async () => {
    const store = await createMemoryStore();
    try {
      const counters = emptyCounters();
      const events: ReaderEvent[] = [];

      // First: malformed (inverted range) — gets rejected.
      const r1 = await processBatch({
        event: event({ startFE: 100, endFE: 50 }),
        parentBeaconBlockRoot: null,
        l1IncludedAtUnixSec: null,
        store,
        sources: {},
        chainId: CHAIN_ID,
        ethCallGasCap: 50_000_000n,
        ethCallTimeoutMs: 5_000,
        counters,
        logger: (e) => events.push(e),
        fetchBlob: async () => {
          throw new Error('must not be reached');
        },
        decode: async () => ({ messages: [], signatures: [] }),
        verifyMessage: async () => true,
      });
      expect(r1.outcome).toBe('range_rejected');

      // Second: a valid event proceeds normally (no decoding needed
      // since `decode` returns an empty list, but the BatchRow lands).
      const valid: BlobBatchRegisteredEvent = {
        ...event({ startFE: 0, endFE: 4096 }),
        txHash: ('0x' + 'bb'.repeat(32)) as Bytes32,
      };
      const r2 = await processBatch({
        event: valid,
        parentBeaconBlockRoot: null,
        l1IncludedAtUnixSec: null,
        store,
        sources: {},
        chainId: CHAIN_ID,
        ethCallGasCap: 50_000_000n,
        ethCallTimeoutMs: 5_000,
        counters,
        logger: (e) => events.push(e),
        fetchBlob: async () => FAKE_BLOB,
        decode: async () => ({ messages: [], signatures: [] }),
        verifyMessage: async () => true,
      });
      expect(r2.outcome).toBe('decoded');

      const batches = await store.withTxn((txn) => txn.listBatches({}));
      expect(batches).toHaveLength(1);
      expect(batches[0]!.txHash).toBe(valid.txHash);
      expect(counters.skippedRange).toBe(1);
    } finally {
      await store.close();
    }
  });
});
