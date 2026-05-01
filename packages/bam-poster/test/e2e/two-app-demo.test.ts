/**
 * Two-app demo coverage (T028).
 *
 * Hermetic check: drive an `AggregatorLoop` with two distinct tags
 * representing the demo apps (`bam-twitter` + `message-in-a-blobble`),
 * each with a small backlog. Assert that ONE packed transaction lands
 * carrying:
 *   - both tags' selections in `outcome.entries`
 *   - both tags' `BatchRow`s in `bam-store` under one shared `txHash`
 *   - the calldata targets `registerBlobBatches` with a 2-element
 *     `BlobBatchCall[]` array
 *
 * This test does NOT exercise a real anvil + deployed BAM Core; it
 * stubs the transport so the round trip is byte-exact at the calldata
 * layer. The real-deployment verification (G-7) lives in the manual
 * smoke run documented in `MIGRATION.md`.
 */

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
import { BAM_CORE_ABI } from 'bam-sdk';
import { createMemoryStore, type BamStore } from 'bam-store';
import { decodeFunctionData, type Kzg } from 'viem';

import { AggregatorLoop } from '../../src/submission/aggregator-loop.js';
import { DEFAULT_BACKOFF } from '../../src/submission/backoff.js';
import {
  buildAndSubmitWithViem,
  type BuildAndSubmitTransport,
} from '../../src/submission/build-and-submit.js';
import type { Signer } from '../../src/types.js';

beforeAll(() => {
  loadTrustedSetup();
});

const CHAIN_ID = 31337;
// Tags chosen to mirror the two demo apps.
const BAM_TWITTER = ('0x' + 'a1'.repeat(32)) as Bytes32;
const BLOBBLE = ('0x' + 'b2'.repeat(32)) as Bytes32;
const BAM_CORE = ('0x' + '22'.repeat(20)) as Address;

const stores: BamStore[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
});

class StubSigner implements Signer {
  account() {
    return {
      address: ('0x' + '11'.repeat(20)) as Address,
      type: 'json-rpc' as const,
    };
  }
}

const stubKzg: Kzg = {
  blobToKzgCommitment: () => new Uint8Array(48),
  computeBlobKzgProof: () => new Uint8Array(48),
};

async function ingest(
  store: BamStore,
  tag: Bytes32,
  count: number,
  ingestedAtBase: number
): Promise<void> {
  await store.withTxn(async (txn) => {
    for (let i = 0; i < count; i++) {
      const priv = generateECDSAPrivateKey();
      const sender = deriveAddress(priv);
      const contents = encodeContents(tag, new Uint8Array([i, i + 1, i + 2]));
      const msg: BAMMessage = { sender, nonce: 1n, contents };
      const sigHex = signECDSAWithKey(priv, msg, CHAIN_ID);
      const signature = hexToBytes(sigHex);
      const messageHash = computeMessageHashForMessage(msg);
      const ingestSeq = await txn.nextIngestSeq(tag);
      await txn.insertPending({
        contentTag: tag,
        sender,
        nonce: 1n,
        contents,
        signature,
        messageHash,
        chainId: CHAIN_ID,
        ingestedAt: ingestedAtBase + i,
        ingestSeq,
      });
    }
  });
}

const alwaysFire = {
  select(tag: Bytes32, pool: { list: (t: Bytes32) => readonly any[] }) {
    const msgs = pool.list(tag);
    if (msgs.length === 0) return null;
    return { msgs: [...msgs] };
  },
};

describe('two-app demo: bam-twitter + message-in-a-blobble (T028)', () => {
  it('one packed tx contains both tags, calldata targets registerBlobBatches with a 2-element array', async () => {
    const store = await createMemoryStore();
    stores.push(store);
    await ingest(store, BAM_TWITTER, 2, 1_000);
    await ingest(store, BLOBBLE, 2, 2_000);

    let observedData: `0x${string}` | null = null;
    const transport: BuildAndSubmitTransport = {
      async sendBlobTransaction({ data }) {
        observedData = data;
        return ('0x' + 'cc'.repeat(32)) as `0x${string}`;
      },
      async waitForReceipt() {
        return { blockNumber: 100n, transactionIndex: 0 };
      },
      async getChainId() {
        return CHAIN_ID;
      },
      async getBytecode() {
        return '0x6060604052' as `0x${string}`;
      },
      async getBalance() {
        return 10n ** 18n;
      },
      async getBlockNumber() {
        return 100n;
      },
      async getTransactionReceipt() {
        return { blockNumber: 100n };
      },
    };

    const { buildAndSubmitMulti } = await buildAndSubmitWithViem({
      rpcUrl: 'http://localhost:8545',
      chainId: CHAIN_ID,
      bamCoreAddress: BAM_CORE,
      signer: new StubSigner(),
      transport,
      kzgLoader: async () => stubKzg,
      logger: () => undefined,
    });

    const loop = new AggregatorLoop({
      tags: [BAM_TWITTER, BLOBBLE],
      chainId: CHAIN_ID,
      store,
      policy: alwaysFire,
      blobCapacityBytes: 130_000,
      buildAndSubmitMulti,
      backoff: DEFAULT_BACKOFF,
      now: () => new Date(0),
      reorgWindowBlocks: 32,
    });

    const outcome = await loop.tick();
    expect(outcome).toBe('success');
    expect(loop.lastPackedSnapshot().tagCount).toBe(2);

    // Calldata targets `registerBlobBatches` with a 2-element array.
    const decoded = decodeFunctionData({
      abi: BAM_CORE_ABI,
      data: observedData!,
    });
    expect(decoded.functionName).toBe('registerBlobBatches');
    const calls = decoded.args![0] as readonly { contentTag: Bytes32 }[];
    expect(calls).toHaveLength(2);
    const tags = calls.map((c) => c.contentTag).sort();
    expect(tags).toEqual([BAM_TWITTER, BLOBBLE].sort());

    // Both tags' BatchRows landed under the same packed `txHash`.
    const rows = await store.withTxn((txn) =>
      txn.getBatchesByTxHash(CHAIN_ID, ('0x' + 'cc'.repeat(32)) as Bytes32)
    );
    expect(rows).toHaveLength(2);
    const rowTags = new Set(rows.map((r) => r.contentTag));
    expect(rowTags).toEqual(new Set([BAM_TWITTER, BLOBBLE]));

    // Both apps' confirmed message rows reference the shared txHash.
    const twitterMsgs = await store.withTxn((txn) =>
      txn.listMessages({ contentTag: BAM_TWITTER, status: 'confirmed' })
    );
    const blobbleMsgs = await store.withTxn((txn) =>
      txn.listMessages({ contentTag: BLOBBLE, status: 'confirmed' })
    );
    expect(twitterMsgs).toHaveLength(2);
    expect(blobbleMsgs).toHaveLength(2);
  });
});
