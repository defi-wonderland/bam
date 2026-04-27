import {
  computeMessageHashForMessage,
  deriveAddress,
  encodeContents,
  generateECDSAPrivateKey,
  hexToBytes,
  signECDSAWithKey,
} from 'bam-sdk';
import type { Address, BAMMessage, Bytes32 } from 'bam-sdk';
import { createMemoryStore } from 'bam-store';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  emptyCounters,
  processBatch,
} from '../../src/loop/process-batch.js';
import type { BlobBatchRegisteredEvent } from '../../src/discovery/log-scan.js';
import type { ReaderEvent } from '../../src/types.js';

const CHAIN_ID = 11155111;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;
const SUBMITTER = '0x0000000000000000000000000000000000c0ffee' as Address;
const TAG_A = ('0x' + 'aa'.repeat(32)) as Bytes32;
const TAG_B = ('0x' + 'bb'.repeat(32)) as Bytes32;

interface SignedMessage {
  message: BAMMessage;
  signature: Uint8Array;
  messageHash: Bytes32;
}

function makeSignedMessage(nonce: bigint, payload: Uint8Array, tag: Bytes32 = TAG_A): SignedMessage {
  const priv = generateECDSAPrivateKey();
  const sender = deriveAddress(priv);
  const contents = encodeContents(tag, payload);
  const message: BAMMessage = { sender, nonce, contents };
  const sigHex = signECDSAWithKey(priv, message, CHAIN_ID);
  return {
    message,
    signature: hexToBytes(sigHex),
    messageHash: computeMessageHashForMessage(message),
  };
}

function makeEvent(opts: {
  txHash?: Bytes32;
  versionedHash?: Bytes32;
  blockNumber?: number;
  txIndex?: number;
  logIndex?: number;
  contentTag?: Bytes32;
  decoder?: Address;
  signatureRegistry?: Address;
}): BlobBatchRegisteredEvent {
  return {
    blockNumber: opts.blockNumber ?? 100,
    txIndex: opts.txIndex ?? 0,
    logIndex: opts.logIndex ?? 0,
    txHash:
      opts.txHash ??
      (('0x' + 'aa'.repeat(32)) as Bytes32),
    versionedHash:
      opts.versionedHash ??
      (('0x' + '01' + '00'.repeat(31)) as Bytes32),
    submitter: SUBMITTER,
    contentTag: opts.contentTag ?? TAG_A,
    decoder: opts.decoder ?? ZERO_ADDRESS,
    signatureRegistry: opts.signatureRegistry ?? ZERO_ADDRESS,
  };
}

const FAKE_BLOB = new Uint8Array(4096 * 32); // 1×128 KB; payload meaningless — the decode stub is injected.

describe('processBatch', () => {
  it('writes a confirmed BatchRow + per-message rows on the happy path', async () => {
    const store = createMemoryStore();
    const counters = emptyCounters();
    const m1 = makeSignedMessage(1n, new Uint8Array([1, 2, 3]));
    const m2 = makeSignedMessage(2n, new Uint8Array([4, 5, 6]));
    const events: ReaderEvent[] = [];
    const event = makeEvent({});

    await processBatch({
      event,
      parentBeaconBlockRoot: ('0x' + 'cc'.repeat(32)) as Bytes32,
      store,
      sources: { beaconUrl: 'https://beacon.example' },
      chainId: CHAIN_ID,
      ethCallGasCap: 50_000_000n,
      ethCallTimeoutMs: 5_000,
      counters,
      logger: (e) => events.push(e),
      now: () => 1_700_000_000_000,
      fetchBlob: async () => FAKE_BLOB,
      decode: async () => ({
        messages: [m1.message, m2.message],
        signatures: [m1.signature, m2.signature],
      }),
      verifyMessage: async () => true,
    });

    expect(counters.decoded).toBe(2);
    expect(counters.skippedVerify).toBe(0);
    expect(counters.skippedDecode).toBe(0);
    expect(counters.undecodable).toBe(0);

    const rows = await store.withTxn(async (txn) =>
      txn.listMessages({ contentTag: TAG_A })
    );
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.status === 'confirmed')).toBe(true);
    expect(rows.every((r) => r.batchRef === event.txHash)).toBe(true);

    const batches = await store.withTxn(async (txn) =>
      txn.listBatches({ contentTag: TAG_A })
    );
    expect(batches.length).toBe(1);
    expect(batches[0].messageSnapshot.length).toBe(2);
    // Reader-written batches leave submittedAt null so a co-located
    // Poster's value isn't clobbered.
    expect(batches[0].submittedAt).toBeNull();

    expect(events.find((e) => e.kind === 'batch_observed')).toBeTruthy();
    expect(events.filter((e) => e.kind === 'message_verified').length).toBe(2);
    expect(events.find((e) => e.kind === 'batch_decoded')).toEqual(
      expect.objectContaining({ kind: 'batch_decoded', messageCount: 2 })
    );
  });

  it('drops a single bad-signature message but lands the rest of the batch', async () => {
    const store = createMemoryStore();
    const counters = emptyCounters();
    const m1 = makeSignedMessage(1n, new Uint8Array([1]));
    const m2 = makeSignedMessage(2n, new Uint8Array([2]));
    const m3 = makeSignedMessage(3n, new Uint8Array([3]));
    let call = 0;
    await processBatch({
      event: makeEvent({}),
      parentBeaconBlockRoot: null,
      store,
      sources: {},
      chainId: CHAIN_ID,
      ethCallGasCap: 50_000_000n,
      ethCallTimeoutMs: 5_000,
      counters,
      fetchBlob: async () => FAKE_BLOB,
      decode: async () => ({
        messages: [m1.message, m2.message, m3.message],
        signatures: [m1.signature, m2.signature, m3.signature],
      }),
      verifyMessage: async () => {
        call += 1;
        return call !== 2; // fail the second
      },
    });

    expect(counters.decoded).toBe(2);
    expect(counters.skippedVerify).toBe(1);

    const rows = await store.withTxn(async (txn) =>
      txn.listMessages({ contentTag: TAG_A })
    );
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.nonce).sort()).toEqual([1n, 3n]);

    const batch = (
      await store.withTxn(async (txn) => txn.listBatches({ contentTag: TAG_A }))
    )[0];
    expect(batch.messageSnapshot.length).toBe(2);
    expect(batch.messageSnapshot.map((s) => s.nonce).sort()).toEqual([1n, 3n]);
  });

  it('writes a BatchRow with empty snapshot and zero MessageRows on structural decode failure', async () => {
    const store = createMemoryStore();
    const counters = emptyCounters();
    const events: ReaderEvent[] = [];
    await processBatch({
      event: makeEvent({}),
      parentBeaconBlockRoot: null,
      store,
      sources: {},
      chainId: CHAIN_ID,
      ethCallGasCap: 50_000_000n,
      ethCallTimeoutMs: 5_000,
      counters,
      logger: (e) => events.push(e),
      fetchBlob: async () => FAKE_BLOB,
      decode: async () => {
        throw new RangeError('batch too short: 0 bytes');
      },
      verifyMessage: async () => true,
    });

    expect(counters.skippedDecode).toBe(1);
    expect(counters.decoded).toBe(0);

    const batches = await store.withTxn(async (txn) =>
      txn.listBatches({ contentTag: TAG_A })
    );
    expect(batches.length).toBe(1);
    expect(batches[0].messageSnapshot).toEqual([]);
    const rows = await store.withTxn(async (txn) =>
      txn.listMessages({ contentTag: TAG_A })
    );
    expect(rows.length).toBe(0);

    expect(events.find((e) => e.kind === 'batch_decode_failed')).toBeTruthy();
  });

  it('continues past a substrate (author, nonce) conflict and preserves the prior row', async () => {
    const store = createMemoryStore();
    const counters = emptyCounters();
    const m1 = makeSignedMessage(1n, new Uint8Array([1]));

    // Pre-populate the substrate with a *different-bytes* row at (m1.author, 1).
    await store.withTxn(async (txn) => {
      await txn.upsertObserved({
        messageId: ('0x' + '11'.repeat(32)) as Bytes32,
        author: m1.message.sender,
        nonce: 1n,
        contentTag: TAG_A,
        contents: encodeContents(TAG_A, new Uint8Array([99])),
        signature: new Uint8Array(65),
        messageHash: ('0x' + 'ee'.repeat(32)) as Bytes32,
        status: 'confirmed',
        batchRef: ('0x' + 'fe'.repeat(32)) as Bytes32,
        ingestedAt: null,
        ingestSeq: null,
        blockNumber: 99,
        txIndex: 0,
        messageIndexWithinBatch: 0,
      });
    });

    const m2 = makeSignedMessage(2n, new Uint8Array([2]));
    const events: ReaderEvent[] = [];
    await processBatch({
      event: makeEvent({}),
      parentBeaconBlockRoot: null,
      store,
      sources: {},
      chainId: CHAIN_ID,
      ethCallGasCap: 50_000_000n,
      ethCallTimeoutMs: 5_000,
      counters,
      logger: (e) => events.push(e),
      fetchBlob: async () => FAKE_BLOB,
      decode: async () => ({
        messages: [m1.message, m2.message],
        signatures: [m1.signature, m2.signature],
      }),
      verifyMessage: async () => true,
    });

    expect(counters.skippedConflict).toBe(1);
    expect(counters.decoded).toBe(1);

    const allRows = await store.withTxn(async (txn) =>
      txn.listMessages({ contentTag: TAG_A })
    );
    // Prior row (with 0xee... messageHash) preserved; m2 landed; m1 rejected.
    expect(allRows.length).toBe(2);
    const prior = allRows.find((r) => r.author === m1.message.sender);
    expect(prior?.messageHash).toBe(('0x' + 'ee'.repeat(32)) as Bytes32);
    expect(events.find((e) => e.kind === 'message_conflict')).toBeTruthy();
  });

  it('writes only an empty BatchRow when the blob is unreachable from all sources', async () => {
    const store = createMemoryStore();
    const counters = emptyCounters();
    const events: ReaderEvent[] = [];
    await processBatch({
      event: makeEvent({}),
      parentBeaconBlockRoot: null,
      store,
      sources: {},
      chainId: CHAIN_ID,
      ethCallGasCap: 50_000_000n,
      ethCallTimeoutMs: 5_000,
      counters,
      logger: (e) => events.push(e),
      fetchBlob: async () => null,
      decode: async () => ({ messages: [], signatures: [] }),
      verifyMessage: async () => true,
    });
    expect(counters.undecodable).toBe(1);
    const batches = await store.withTxn(async (txn) =>
      txn.listBatches({ contentTag: TAG_A })
    );
    expect(batches.length).toBe(1);
    expect(batches[0].messageSnapshot).toEqual([]);
    const rows = await store.withTxn(async (txn) =>
      txn.listMessages({ contentTag: TAG_A })
    );
    expect(rows.length).toBe(0);
    expect(events.find((e) => e.kind === 'blob_unreachable')).toBeTruthy();
  });

  it('writes two distinct BatchRows when the same versionedHash registers under two tags (red-team C-6)', async () => {
    const store = createMemoryStore();
    const counters = emptyCounters();
    const versionedHash = ('0x01' + 'cc'.repeat(31)) as Bytes32;
    const m1 = makeSignedMessage(1n, new Uint8Array([1]), TAG_A);
    const m2 = makeSignedMessage(2n, new Uint8Array([2]), TAG_B);
    const eventA = makeEvent({
      versionedHash,
      txHash: ('0x' + '01'.repeat(32)) as Bytes32,
      contentTag: TAG_A,
    });
    const eventB = makeEvent({
      versionedHash,
      txHash: ('0x' + '02'.repeat(32)) as Bytes32,
      contentTag: TAG_B,
      blockNumber: 101,
    });
    await processBatch({
      event: eventA,
      parentBeaconBlockRoot: null,
      store,
      sources: {},
      chainId: CHAIN_ID,
      ethCallGasCap: 50_000_000n,
      ethCallTimeoutMs: 5_000,
      counters,
      fetchBlob: async () => FAKE_BLOB,
      decode: async () => ({ messages: [m1.message], signatures: [m1.signature] }),
      verifyMessage: async () => true,
    });
    await processBatch({
      event: eventB,
      parentBeaconBlockRoot: null,
      store,
      sources: {},
      chainId: CHAIN_ID,
      ethCallGasCap: 50_000_000n,
      ethCallTimeoutMs: 5_000,
      counters,
      fetchBlob: async () => FAKE_BLOB,
      decode: async () => ({ messages: [m2.message], signatures: [m2.signature] }),
      verifyMessage: async () => true,
    });
    const allBatches = await store.withTxn(async (txn) =>
      txn.listBatches({ chainId: CHAIN_ID })
    );
    expect(allBatches.length).toBe(2);
    expect(new Set(allBatches.map((b) => b.contentTag))).toEqual(new Set([TAG_A, TAG_B]));
    expect(allBatches.every((b) => b.blobVersionedHash === versionedHash)).toBe(true);
  });
});
