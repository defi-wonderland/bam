/**
 * End-to-end packed multi-segment decode (006-blob-packing-multi-tag).
 *
 * Asserts that a blob assembled from two per-tag segments at distinct
 * FE-aligned ranges round-trips through the Reader's pipeline:
 *
 *   1. `assembleMultiSegmentBlob` lays the segments at known offsets.
 *   2. `scanLogs` joins `BlobBatchRegistered` with `BlobSegmentDeclared`
 *      events by `(txHash, contentTag)` so each batch event carries its
 *      tight `(startFE, endFE)` range.
 *   3. `processBatch` slices the blob with that range and decodes each
 *      tag's bytes back to its original messages.
 *   4. The store ends up with one `BatchRow` per tag — each holding
 *      only the messages for *that* tag.
 *
 * This is the regression test the feature was missing: prior to wiring
 * the segment-event join, the scanner defaulted to the full-blob range
 * and the decoder would receive every tag's bytes concatenated, failing
 * to produce per-tag rows.
 */

import {
  assembleMultiSegmentBlob,
  computeMessageHashForMessage,
  decodeBatch,
  deriveAddress,
  encodeBatch,
  encodeContents,
  generateECDSAPrivateKey,
  hexToBytes,
  signECDSAWithKey,
  type Address,
  type BAMMessage,
  type Bytes32,
} from 'bam-sdk';
import { createMemoryStore } from 'bam-store';
import { describe, expect, it } from 'vitest';

import { scanLogs, type LogScanClient } from '../../src/discovery/log-scan.js';
import {
  emptyCounters,
  processBatch,
} from '../../src/loop/process-batch.js';

const CHAIN_ID = 11155111;
const TAG_A = ('0x' + 'a1'.repeat(32)) as Bytes32;
const TAG_B = ('0x' + 'b2'.repeat(32)) as Bytes32;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;
const PACKED_TX = ('0x' + 'cc'.repeat(32)) as Bytes32;
const PACKED_VH = ('0x01' + 'cc'.repeat(31)) as Bytes32;
const PACKED_BLOCK = 200;
const SUBMITTER = '0x000000000000000000000000000000000000ab12' as Address;
const BAM_CORE = '0x000000000000000000000000000000000000c07e' as Address;

interface SignedEntry {
  message: BAMMessage;
  signature: Uint8Array;
  messageHash: Bytes32;
}

function signedEntry(tag: Bytes32, nonce: bigint, marker: number): SignedEntry {
  const priv = generateECDSAPrivateKey();
  const sender = deriveAddress(priv);
  const contents = encodeContents(tag, new Uint8Array([marker]));
  const message: BAMMessage = { sender, nonce, contents };
  const sigHex = signECDSAWithKey(priv, message, CHAIN_ID);
  return {
    message,
    signature: hexToBytes(sigHex),
    messageHash: computeMessageHashForMessage(message),
  };
}

function fakeL1WithSegments(rows: {
  batches: Array<{
    txHash: Bytes32;
    blockNumber: number;
    txIndex: number;
    logIndex: number;
    versionedHash: Bytes32;
    contentTag: Bytes32;
  }>;
  segments: Array<{
    txHash: Bytes32;
    blockNumber: number;
    txIndex: number;
    logIndex: number;
    versionedHash: Bytes32;
    startFE: number;
    endFE: number;
    contentTag: Bytes32;
  }>;
}): LogScanClient {
  return {
    async getLogs(args) {
      const fromBlock = Number(args.fromBlock);
      const toBlock = Number(args.toBlock);
      const batchOut = rows.batches
        .filter((b) => b.blockNumber >= fromBlock && b.blockNumber <= toBlock)
        .map((b) => ({
          eventName: 'BlobBatchRegistered' as const,
          blockNumber: BigInt(b.blockNumber),
          transactionIndex: BigInt(b.txIndex),
          logIndex: BigInt(b.logIndex),
          transactionHash: b.txHash,
          args: {
            versionedHash: b.versionedHash,
            submitter: SUBMITTER,
            contentTag: b.contentTag,
            decoder: ZERO_ADDRESS,
            signatureRegistry: ZERO_ADDRESS,
          },
        }));
      const segmentOut = rows.segments
        .filter((s) => s.blockNumber >= fromBlock && s.blockNumber <= toBlock)
        .map((s) => ({
          eventName: 'BlobSegmentDeclared' as const,
          blockNumber: BigInt(s.blockNumber),
          transactionIndex: BigInt(s.txIndex),
          logIndex: BigInt(s.logIndex),
          transactionHash: s.txHash,
          args: {
            versionedHash: s.versionedHash,
            declarer: SUBMITTER,
            startFE: s.startFE,
            endFE: s.endFE,
            contentTag: s.contentTag,
          },
        }));
      return [...batchOut, ...segmentOut];
    },
  };
}

describe('packed multi-segment decode (end-to-end)', () => {
  it('two tags packed into one blob → two BatchRows with the right per-tag messages', async () => {
    // 1. Build two distinct per-tag batches.
    const aMessages = [signedEntry(TAG_A, 1n, 1), signedEntry(TAG_A, 2n, 2)];
    const bMessages = [signedEntry(TAG_B, 1n, 11)];

    const encA = encodeBatch(
      aMessages.map((e) => e.message),
      aMessages.map((e) => e.signature)
    );
    const encB = encodeBatch(
      bMessages.map((e) => e.message),
      bMessages.map((e) => e.signature)
    );

    // 2. Pack into one blob at FE-aligned offsets.
    const assembled = assembleMultiSegmentBlob([
      { contentTag: TAG_A, payload: encA.data },
      { contentTag: TAG_B, payload: encB.data },
    ]);
    expect(assembled.segments).toHaveLength(2);
    const [segA, segB] = assembled.segments;
    // Sanity: ranges are non-overlapping and contiguous.
    expect(segA!.endFE).toBe(segB!.startFE);

    // 3. Stub L1 with one BBR + one BSD per per-tag entry (the contract
    //    emits them in pairs inside `registerBlobBatches`).
    const l1 = fakeL1WithSegments({
      batches: [
        {
          txHash: PACKED_TX,
          blockNumber: PACKED_BLOCK,
          txIndex: 0,
          logIndex: 1,
          versionedHash: PACKED_VH,
          contentTag: TAG_A,
        },
        {
          txHash: PACKED_TX,
          blockNumber: PACKED_BLOCK,
          txIndex: 0,
          logIndex: 3,
          versionedHash: PACKED_VH,
          contentTag: TAG_B,
        },
      ],
      segments: [
        {
          txHash: PACKED_TX,
          blockNumber: PACKED_BLOCK,
          txIndex: 0,
          logIndex: 0,
          versionedHash: PACKED_VH,
          startFE: segA!.startFE,
          endFE: segA!.endFE,
          contentTag: TAG_A,
        },
        {
          txHash: PACKED_TX,
          blockNumber: PACKED_BLOCK,
          txIndex: 0,
          logIndex: 2,
          versionedHash: PACKED_VH,
          startFE: segB!.startFE,
          endFE: segB!.endFE,
          contentTag: TAG_B,
        },
      ],
    });

    // 4. Scan: expect both BBR events back, each carrying its joined range.
    const events = await scanLogs({
      publicClient: l1,
      bamCoreAddress: BAM_CORE,
      fromBlock: 0,
      toBlock: PACKED_BLOCK + 10,
    });
    expect(events).toHaveLength(2);
    const eA = events.find((e) => e.contentTag === TAG_A)!;
    const eB = events.find((e) => e.contentTag === TAG_B)!;
    expect(eA.startFE).toBe(segA!.startFE);
    expect(eA.endFE).toBe(segA!.endFE);
    expect(eB.startFE).toBe(segB!.startFE);
    expect(eB.endFE).toBe(segB!.endFE);

    // 5. processBatch each event against the assembled blob, asserting
    //    per-tag slices decode to their original messages and *only*
    //    those messages.
    const store = await createMemoryStore();
    try {
      const counters = emptyCounters();
      for (const ev of events) {
        const expected =
          ev.contentTag === TAG_A ? aMessages : bMessages;
        const result = await processBatch({
          event: ev,
          parentBeaconBlockRoot: null,
          l1IncludedAtUnixSec: PACKED_BLOCK,
          store,
          sources: {},
          chainId: CHAIN_ID,
          ethCallGasCap: 50_000_000n,
          ethCallTimeoutMs: 5_000,
          counters,
          fetchBlob: async () => assembled.blob,
          decode: async ({ usableBytes }) => {
            // Real decode through the SDK — proves the per-tag slice
            // matches `encodeBatch`'s output byte-for-byte (modulo FE
            // alignment padding past the encoded length, which the
            // decoder ignores).
            const decoded = decodeBatch(
              usableBytes.subarray(
                0,
                ev.contentTag === TAG_A ? encA.data.length : encB.data.length
              )
            );
            return {
              messages: decoded.messages,
              signatures: expected.map((e) => e.signature),
            };
          },
          verifyMessage: async () => true,
          now: () => 1_700_000_000_000,
        });
        expect(result.outcome).toBe('decoded');
        expect(result.messagesWritten).toBe(expected.length);
      }

      // 6. Convergence assertions: two distinct BatchRows under the
      //    packed txHash, each scoped to its own tag and message set.
      const rows = await store.withTxn((txn) =>
        txn.getBatchesByTxHash(CHAIN_ID, PACKED_TX)
      );
      expect(rows).toHaveLength(2);
      const rowA = rows.find((r) => r.contentTag === TAG_A)!;
      const rowB = rows.find((r) => r.contentTag === TAG_B)!;
      expect(rowA.messageSnapshot).toHaveLength(aMessages.length);
      expect(rowB.messageSnapshot).toHaveLength(bMessages.length);
      expect(rowA.messageSnapshot.map((m) => m.messageHash).sort()).toEqual(
        aMessages.map((m) => m.messageHash).sort()
      );
      expect(rowB.messageSnapshot.map((m) => m.messageHash).sort()).toEqual(
        bMessages.map((m) => m.messageHash).sort()
      );

      // Per-tag MessageRows are scoped to the right tag.
      const msgsA = await store.withTxn((txn) =>
        txn.listMessages({ contentTag: TAG_A })
      );
      const msgsB = await store.withTxn((txn) =>
        txn.listMessages({ contentTag: TAG_B })
      );
      expect(msgsA).toHaveLength(aMessages.length);
      expect(msgsB).toHaveLength(bMessages.length);
    } finally {
      await store.close();
    }
  });
});
