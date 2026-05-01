/**
 * Poster + Reader convergence integration test (acceptance criterion #2;
 * red-team C-6 cross-cut).
 *
 * Setup: a single in-process PGLite `bam-store` is shared by both writers.
 *
 *   - The Poster path is exercised by writing through the substrate
 *     directly with the same shape `bam-poster`'s `submission/loop.ts`
 *     produces (non-empty `messageSnapshot`, `confirmed` MessageRows
 *     keyed to a `txHash`).
 *   - The Reader path is exercised by running the real `processBatch`
 *     pipeline against an injected `decode` that returns the same
 *     messages + signatures the Poster wrote.
 *
 * Asserts:
 *   - Exactly one `BatchRow` for the shared `txHash`.
 *   - Its `messageSnapshot` is the Poster's non-empty snapshot
 *     (Reader's write does not clobber).
 *   - `MessageRow` count equals Poster's submitted-message count.
 *   - No row's fields were clobbered by the second writer.
 */

import {
  computeMessageHashForMessage,
  computeMessageId,
  deriveAddress,
  encodeContents,
  generateECDSAPrivateKey,
  hexToBytes,
  signECDSAWithKey,
} from 'bam-sdk';
import type { Address, BAMMessage, Bytes32 } from 'bam-sdk';
import { createMemoryStore, type BatchMessageSnapshotEntry } from 'bam-store';
import { describe, expect, it } from 'vitest';

import { processBatch, emptyCounters } from '../../src/loop/process-batch.js';
import type { BlobBatchRegisteredEvent } from '../../src/discovery/log-scan.js';

const CHAIN_ID = 11155111;
const TAG = ('0x' + 'aa'.repeat(32)) as Bytes32;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;
const TX_HASH = ('0x' + '01'.repeat(32)) as Bytes32;
const VERSIONED_HASH = ('0x01' + '02'.repeat(31)) as Bytes32;
const SUBMITTER = '0x000000000000000000000000000000000000ab12' as Address;

interface SignedMessage {
  message: BAMMessage;
  signature: Uint8Array;
  messageHash: Bytes32;
}

function makeSignedMessage(nonce: bigint, payload: Uint8Array): SignedMessage {
  const priv = generateECDSAPrivateKey();
  const sender = deriveAddress(priv);
  const contents = encodeContents(TAG, payload);
  const message: BAMMessage = { sender, nonce, contents };
  const sigHex = signECDSAWithKey(priv, message, CHAIN_ID);
  return {
    message,
    signature: hexToBytes(sigHex),
    messageHash: computeMessageHashForMessage(message),
  };
}

const FAKE_BLOB = new Uint8Array(4096 * 32);

describe('Poster + Reader convergence', () => {

  it('Poster-first then Reader: snapshot preserved, no clobber, single batch row', async () => {
    const store = await createMemoryStore();
    try {
      const m1 = makeSignedMessage(1n, new Uint8Array([1]));
      const m2 = makeSignedMessage(2n, new Uint8Array([2]));
      const batchContentHash = VERSIONED_HASH;

      // ── Poster path: write a confirmed BatchRow + MessageRows.
      const posterSnapshot: BatchMessageSnapshotEntry[] = [
        {
          author: m1.message.sender,
          nonce: 1n,
          messageId: computeMessageId(m1.message.sender, 1n, batchContentHash),
          messageHash: m1.messageHash,
          messageIndexWithinBatch: 0,
        },
        {
          author: m2.message.sender,
          nonce: 2n,
          messageId: computeMessageId(m2.message.sender, 2n, batchContentHash),
          messageHash: m2.messageHash,
          messageIndexWithinBatch: 1,
        },
      ];
      const POSTER_INGESTED_AT = 1_700_000_000_000;
      await store.withTxn(async (txn) => {
        await txn.upsertBatch({
          txHash: TX_HASH,
          chainId: CHAIN_ID,
          contentTag: TAG,
          blobVersionedHash: VERSIONED_HASH,
          batchContentHash,
          blockNumber: 100,
          txIndex: 0,
          status: 'confirmed',
          replacedByTxHash: null,
          submittedAt: POSTER_INGESTED_AT,
          invalidatedAt: null,
          submitter: null,
          l1IncludedAtUnixSec: null,
          messageSnapshot: posterSnapshot,
        });
        for (const [i, sm] of [m1, m2].entries()) {
          await txn.upsertObserved({
            messageId: computeMessageId(sm.message.sender, sm.message.nonce, batchContentHash),
            author: sm.message.sender,
            nonce: sm.message.nonce,
            contentTag: TAG,
            contents: new Uint8Array(sm.message.contents),
            signature: new Uint8Array(sm.signature),
            messageHash: sm.messageHash,
            status: 'confirmed',
            batchRef: TX_HASH,
            chainId: CHAIN_ID,
            ingestedAt: POSTER_INGESTED_AT,
            ingestSeq: i + 1,
            blockNumber: 100,
            txIndex: 0,
            messageIndexWithinBatch: i,
          });
        }
      });

      // ── Reader path: process the same event over the same store.
      const event: BlobBatchRegisteredEvent = {
        blockNumber: 100,
        txIndex: 0,
        logIndex: 0,
        txHash: TX_HASH,
        versionedHash: VERSIONED_HASH,
        submitter: SUBMITTER,
        contentTag: TAG,
        decoder: ZERO_ADDRESS,
        signatureRegistry: ZERO_ADDRESS,
      };
      const counters = emptyCounters();
      await processBatch({
        event,
        parentBeaconBlockRoot: null,
        l1IncludedAtUnixSec: null,
        store,
        sources: {},
        chainId: CHAIN_ID,
        ethCallGasCap: 50_000_000n,
        ethCallTimeoutMs: 5_000,
        counters,
        fetchBlob: async () => FAKE_BLOB,
        decode: async () => ({
          messages: [m1.message, m2.message],
          signatures: [m1.signature, m2.signature],
        }),
        verifyMessage: async () => true,
        now: () => POSTER_INGESTED_AT + 5_000,
      });

      // ── Convergence assertions.
      const batches = await store.withTxn(async (txn) =>
        txn.listBatches({ chainId: CHAIN_ID })
      );
      expect(batches.length).toBe(1);
      const batch = batches[0];
      expect(batch.txHash).toBe(TX_HASH);
      // Poster's snapshot survives the Reader's upsert.
      expect(batch.messageSnapshot.length).toBe(2);
      expect(batch.messageSnapshot.map((e) => e.nonce).sort()).toEqual([1n, 2n]);
      // submittedAt is the Poster's ingested timestamp (COALESCE preserves it).
      expect(batch.submittedAt).toBe(POSTER_INGESTED_AT);

      const rows = await store.withTxn(async (txn) =>
        txn.listMessages({ contentTag: TAG })
      );
      expect(rows.length).toBe(2);
      // Poster's ingestedAt + ingestSeq are preserved on the rows.
      const r1 = rows.find((r) => r.nonce === 1n);
      const r2 = rows.find((r) => r.nonce === 2n);
      expect(r1?.ingestedAt).toBe(POSTER_INGESTED_AT);
      expect(r2?.ingestedAt).toBe(POSTER_INGESTED_AT);
      expect(r1?.ingestSeq).toBe(1);
      expect(r2?.ingestSeq).toBe(2);
    } finally {
      await store.close();
    }
  });

  it('Reader-first then Poster: Reader writes empty snapshot; Poster fills it in', async () => {
    const store = await createMemoryStore();
    try {
      const m1 = makeSignedMessage(1n, new Uint8Array([1]));
      const event: BlobBatchRegisteredEvent = {
        blockNumber: 100,
        txIndex: 0,
        logIndex: 0,
        txHash: TX_HASH,
        versionedHash: VERSIONED_HASH,
        submitter: SUBMITTER,
        contentTag: TAG,
        decoder: ZERO_ADDRESS,
        signatureRegistry: ZERO_ADDRESS,
      };
      const counters = emptyCounters();
      // Reader sees the event but cannot reach the blob — writes a
      // confirmed BatchRow with an *empty* snapshot and zero
      // MessageRows. This is the path that needs to be exercised: a
      // later Poster write should fill the snapshot in (rather than
      // the Reader's empty snapshot sticking).
      await processBatch({
        event,
        parentBeaconBlockRoot: null,
        l1IncludedAtUnixSec: null,
        store,
        sources: {},
        chainId: CHAIN_ID,
        ethCallGasCap: 50_000_000n,
        ethCallTimeoutMs: 5_000,
        counters,
        fetchBlob: async () => null,
      });

      // Sanity: Reader's row is in place with an empty snapshot.
      const afterReader = await store.withTxn(async (txn) =>
        txn.listBatches({ chainId: CHAIN_ID })
      );
      expect(afterReader.length).toBe(1);
      expect(afterReader[0].messageSnapshot.length).toBe(0);

      // Now the Poster writes the same batch with non-empty snapshot.
      const batchContentHash = VERSIONED_HASH;
      const posterSnapshot: BatchMessageSnapshotEntry[] = [
        {
          author: m1.message.sender,
          nonce: 1n,
          messageId: computeMessageId(m1.message.sender, 1n, batchContentHash),
          messageHash: m1.messageHash,
          messageIndexWithinBatch: 0,
        },
      ];
      await store.withTxn(async (txn) => {
        await txn.upsertBatch({
          txHash: TX_HASH,
          chainId: CHAIN_ID,
          contentTag: TAG,
          blobVersionedHash: VERSIONED_HASH,
          batchContentHash,
          blockNumber: 100,
          txIndex: 0,
          status: 'confirmed',
          replacedByTxHash: null,
          submittedAt: 999,
          invalidatedAt: null,
          submitter: null,
          l1IncludedAtUnixSec: null,
          messageSnapshot: posterSnapshot,
        });
      });

      const batches = await store.withTxn(async (txn) =>
        txn.listBatches({ chainId: CHAIN_ID })
      );
      expect(batches.length).toBe(1);
      // The Poster's non-empty snapshot replaces the Reader's empty
      // one — the merge semantics are about preserving information,
      // not about first-write-wins per se.
      expect(batches[0].messageSnapshot.length).toBe(1);
      expect(batches[0].messageSnapshot[0].nonce).toBe(1n);
      expect(batches[0].submittedAt).toBe(999);
    } finally {
      await store.close();
    }
  });
});
