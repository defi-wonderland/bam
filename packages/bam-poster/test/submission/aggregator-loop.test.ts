import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  computeMessageHashForMessage,
  deriveAddress,
  encodeContents,
  generateECDSAPrivateKey,
  hexToBytes,
  loadTrustedSetup,
  signECDSAWithKey,
  type Address,
  type BAMMessage,
  type Bytes32,
} from 'bam-sdk';
import { createMemoryStore, type BamStore } from 'bam-store';

import { AggregatorLoop } from '../../src/submission/aggregator-loop.js';
import { defaultBatchPolicy } from '../../src/policy/default.js';
import { DEFAULT_BACKOFF } from '../../src/submission/backoff.js';
import type { BuildAndSubmitMulti, PackedSubmitOutcome } from '../../src/submission/types.js';

beforeAll(() => {
  loadTrustedSetup();
});

const CHAIN_ID = 31337;
const TAG_A = ('0x' + 'a1'.repeat(32)) as Bytes32;
const TAG_B = ('0x' + 'b2'.repeat(32)) as Bytes32;

const stores: BamStore[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
});

async function newStore(): Promise<BamStore> {
  const store = await createMemoryStore();
  stores.push(store);
  return store;
}

function bytes32(label: string, n: number): Bytes32 {
  const hex = (label + n.toString(16)).padStart(64, '0');
  return ('0x' + hex) as Bytes32;
}

async function ingest(
  store: BamStore,
  tag: Bytes32,
  count: number
): Promise<{ message: BAMMessage; signature: Uint8Array }[]> {
  const out: { message: BAMMessage; signature: Uint8Array }[] = [];
  await store.withTxn(async (txn) => {
    for (let i = 0; i < count; i++) {
      const priv = generateECDSAPrivateKey();
      const sender = deriveAddress(priv);
      const contents = encodeContents(tag, new Uint8Array([i, i, i, i]));
      const message: BAMMessage = { sender, nonce: 1n, contents };
      const sigHex = signECDSAWithKey(priv, message, CHAIN_ID);
      const signature = hexToBytes(sigHex);
      const messageHash = computeMessageHashForMessage(message);
      const ingestSeq = await txn.nextIngestSeq(tag);
      await txn.insertPending({
        contentTag: tag,
        sender,
        nonce: 1n,
        contents,
        signature,
        messageHash,
        chainId: CHAIN_ID,
        ingestedAt: Date.now() + i,
        ingestSeq,
      });
      out.push({ message, signature });
    }
  });
  return out;
}

describe('AggregatorLoop', () => {
  it('idle when no tag has pending data', async () => {
    const store = await newStore();
    const buildAndSubmitMulti: BuildAndSubmitMulti = async () => {
      throw new Error('should not be called on an empty tick');
    };
    const loop = new AggregatorLoop({
      tags: [TAG_A, TAG_B],
      chainId: CHAIN_ID,
      store,
      policy: defaultBatchPolicy(),
      blobCapacityBytes: 130_000,
      buildAndSubmitMulti,
      backoff: DEFAULT_BACKOFF,
      now: () => new Date(0),
      reorgWindowBlocks: 32,
    });
    const outcome = await loop.tick();
    expect(outcome).toBe('idle');
  });

  it('packs both tags and writes one BatchRow per included tag in one withTxn', async () => {
    const store = await newStore();
    await ingest(store, TAG_A, 3);
    await ingest(store, TAG_B, 2);

    const stubTxHash = bytes32('99', 1);
    const stubVersionedHash = ('0x01' + '00'.repeat(31)) as Bytes32;
    const submitter = ('0x' + '11'.repeat(20)) as Address;

    let observedPackEntries = 0;
    const buildAndSubmitMulti: BuildAndSubmitMulti = async ({ pack }) => {
      observedPackEntries = pack.plan.included.length;
      const outcome: PackedSubmitOutcome = {
        kind: 'included',
        txHash: stubTxHash,
        blockNumber: 100,
        txIndex: 0,
        blobVersionedHash: stubVersionedHash,
        submitter,
        entries: pack.plan.included.map((seg) => {
          const sel = pack.includedSelections.get(seg.contentTag)!;
          return {
            contentTag: seg.contentTag,
            startFE: seg.startFE,
            endFE: seg.endFE,
            messages: sel.messages,
          };
        }),
      };
      return outcome;
    };

    // Force the policy to fire on every tag with non-empty pool by
    // using a "size: 1" policy. The default policy needs >= 75% blob
    // fill or 60s age to fire — too slow for a unit test. Use a
    // simple always-fire policy that selects every pending message.
    const alwaysFire = {
      select(tag: Bytes32, pool: { list: (t: Bytes32) => readonly any[] }) {
        const msgs = pool.list(tag);
        if (msgs.length === 0) return null;
        return { msgs: [...msgs] };
      },
    };

    const loop = new AggregatorLoop({
      tags: [TAG_A, TAG_B],
      chainId: CHAIN_ID,
      store,
      policy: alwaysFire,
      blobCapacityBytes: 130_000,
      buildAndSubmitMulti,
      backoff: DEFAULT_BACKOFF,
      now: () => new Date(2_000),
      reorgWindowBlocks: 32,
    });

    const outcome = await loop.tick();
    expect(outcome).toBe('success');
    expect(observedPackEntries).toBe(2);
    expect(loop.lastPackedSnapshot()).toEqual({
      txHash: stubTxHash,
      tagCount: 2,
    });

    // Both tags' BatchRows landed under the same txHash.
    const rows = await store.withTxn((txn) =>
      txn.getBatchesByTxHash(CHAIN_ID, stubTxHash)
    );
    expect(rows).toHaveLength(2);
    const tags = new Set(rows.map((r) => r.contentTag));
    expect(tags).toEqual(new Set([TAG_A, TAG_B]));

    // Per-message rows transitioned to confirmed under the right batch_ref.
    const confirmedA = await store.withTxn((txn) =>
      txn.listMessages({ contentTag: TAG_A, status: 'confirmed' })
    );
    const confirmedB = await store.withTxn((txn) =>
      txn.listMessages({ contentTag: TAG_B, status: 'confirmed' })
    );
    expect(confirmedA).toHaveLength(3);
    expect(confirmedB).toHaveLength(2);
    expect(confirmedA.every((r) => r.batchRef === stubTxHash)).toBe(true);
    expect(confirmedB.every((r) => r.batchRef === stubTxHash)).toBe(true);
  });

  it('permanent failure halts the loop and subsequent ticks return permanent', async () => {
    const store = await newStore();
    await ingest(store, TAG_A, 1);
    const buildAndSubmitMulti: BuildAndSubmitMulti = async () => ({
      kind: 'permanent',
      detail: 'self_check:slice-bytes-mismatch',
    });
    const alwaysFire = {
      select(tag: Bytes32, pool: { list: (t: Bytes32) => readonly any[] }) {
        const msgs = pool.list(tag);
        if (msgs.length === 0) return null;
        return { msgs: [...msgs] };
      },
    };

    const loop = new AggregatorLoop({
      tags: [TAG_A],
      chainId: CHAIN_ID,
      store,
      policy: alwaysFire,
      blobCapacityBytes: 130_000,
      buildAndSubmitMulti,
      backoff: DEFAULT_BACKOFF,
      now: () => new Date(0),
      reorgWindowBlocks: 32,
    });
    expect(await loop.tick()).toBe('permanent');
    expect(loop.isPermanentlyStopped()).toBe(true);
    // Subsequent ticks short-circuit.
    expect(await loop.tick()).toBe('permanent');
    expect(loop.healthState()).toBe('unhealthy');
  });
});
