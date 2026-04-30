/**
 * Self-check fault-injection (T026, G-5, C-1).
 *
 * Inject a 1-byte off-by-one into the producer-side `(startFE, endFE)`
 * arithmetic AFTER plan + assembly. The producer's runtime self-check
 * (T020) MUST detect the slice mismatch, refuse to broadcast, and
 * classify the failure permanent.
 *
 * Removing the self-check (or short-circuiting it) MUST make this
 * test fail — the fault would otherwise reach the wire and produce a
 * self-consistent blob whose per-tag slice mis-decodes silently on
 * the read side.
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  computeMessageHashForMessage,
  deriveAddress,
  encodeBatch,
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
import type { Kzg } from 'viem';

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
const TAG_A = ('0x' + 'a1'.repeat(32)) as Bytes32;
const TAG_B = ('0x' + 'b2'.repeat(32)) as Bytes32;
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
  count: number
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
        ingestedAt: Date.now() + i,
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

describe('self-check fault injection (T026, G-5)', () => {
  it('1-byte off-by-one in plan-vs-assembly is caught BEFORE broadcast → permanent', async () => {
    const store = await createMemoryStore();
    stores.push(store);
    await ingest(store, TAG_A, 2);
    await ingest(store, TAG_B, 1);

    let broadcasted = false;
    const transport: BuildAndSubmitTransport = {
      async sendBlobTransaction() {
        broadcasted = true;
        return ('0x' + 'ff'.repeat(32)) as `0x${string}`;
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

    // Wrap the multi-submit to inject a 1-byte off-by-one in the
    // plan AFTER the aggregator hands it over. The plan's
    // `(startFE, endFE)` no longer agrees with what the SDK would
    // assemble; the self-check must catch it.
    const fault = async (args: Parameters<typeof buildAndSubmitMulti>[0]) => {
      const planEntry = args.pack.plan.included[0];
      if (planEntry !== undefined) {
        // Off-by-one: shift startFE forward without adjusting endFE.
        // Slice for TAG_A's segment now starts one FE later than
        // its original payload begins → bytes mismatch → permanent.
        planEntry.startFE += 1;
        planEntry.endFE += 1;
      }
      return buildAndSubmitMulti(args);
    };

    const loop = new AggregatorLoop({
      tags: [TAG_A, TAG_B],
      chainId: CHAIN_ID,
      store,
      policy: alwaysFire,
      blobCapacityBytes: 130_000,
      buildAndSubmitMulti: fault,
      backoff: DEFAULT_BACKOFF,
      now: () => new Date(0),
      reorgWindowBlocks: 32,
    });

    const outcome = await loop.tick();
    expect(outcome).toBe('permanent');
    expect(broadcasted).toBe(false);
    expect(loop.isPermanentlyStopped()).toBe(true);
    expect(loop.healthState()).toBe('unhealthy');

    // No BatchRow was written under the (would-be) packed txHash.
    const allBatches = await store.withTxn((txn) =>
      txn.listBatches({ chainId: CHAIN_ID })
    );
    expect(allBatches).toHaveLength(0);
  });
});
