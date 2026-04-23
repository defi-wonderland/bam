import { describe, it, expect, beforeEach } from 'vitest';
import {
  bytesToHex,
  computeMessageHash,
  generateECDSAPrivateKey,
  signECDSA,
  type Address,
  type Bytes32,
} from 'bam-sdk';
import { privateKeyToAccount } from 'viem/accounts';

import {
  LocalEcdsaSigner,
  _clearSignerRegistryForTests,
  createMemoryStore,
  createPoster,
} from '../../src/index.js';
import type {
  BlockSource,
  BuildAndSubmit,
  Poster,
  PosterFactoryExtras,
  SubmitOutcome,
} from '../../src/index.js';

const TAG_A = ('0x' + 'aa'.repeat(32)) as Bytes32;
const TAG_B = ('0x' + 'bb'.repeat(32)) as Bytes32;
const BAM_CORE = '0x9C4b230066a6808D83F5FBa0c040E0Df2Fcc7314' as Address;

class FakeChain {
  head = 100n;
  /** txHash → current canonical block, or null if reorged out. */
  txs = new Map<Bytes32, number | null>();

  readonly blockSource: BlockSource = {
    getBlockNumber: async () => this.head,
    getTransactionBlock: async (txHash: Bytes32) => {
      const b = this.txs.get(txHash);
      return b === undefined ? null : b;
    },
  };

  include(txHash: Bytes32, block: number): void {
    this.txs.set(txHash, block);
    if (BigInt(block) > this.head) this.head = BigInt(block);
  }
  reorg(txHash: Bytes32): void {
    this.txs.set(txHash, null);
  }
}

interface Harness {
  poster: Poster;
  chain: FakeChain;
  submittedCalls: Array<{ tag: Bytes32; messageIds: Bytes32[] }>;
  nextTxId: () => Bytes32;
  tickTag: (tag: Bytes32) => Promise<void>;
  tickReorg: () => Promise<{ reorgedCount: number; keptCount: number }>;
}

async function makeHarness(allowlist: Bytes32[]): Promise<Harness> {
  const chain = new FakeChain();
  let counter = 1;
  const nextTxId = (): Bytes32 => {
    const n = counter++;
    return (`0x${n.toString(16).padStart(64, '0')}`) as Bytes32;
  };
  const submittedCalls: Harness['submittedCalls'] = [];
  const buildAndSubmit: BuildAndSubmit = async ({ contentTag, messages }) => {
    submittedCalls.push({ tag: contentTag, messageIds: messages.map((m) => m.messageId) });
    const txHash = nextTxId();
    chain.include(txHash, Number(chain.head));
    return {
      kind: 'included',
      txHash,
      blobVersionedHash: (`0x${'cd'.repeat(32)}`) as Bytes32,
      blockNumber: Number(chain.head),
    } satisfies SubmitOutcome;
  };
  const extras: PosterFactoryExtras = {
    buildAndSubmit,
    rpc: {
      async getChainId() {
        return 1;
      },
      async getCode() {
        return '0x6080' as `0x${string}`;
      },
      async getBalance() {
        return 10n ** 18n;
      },
      getBlockNumber: chain.blockSource.getBlockNumber,
      getTransactionBlock: chain.blockSource.getTransactionBlock,
    },
  };

  // Distinct signer per harness (to avoid cross-test pollution).
  const pk = generateECDSAPrivateKey() as `0x${string}`;
  const signer = new LocalEcdsaSigner(pk);
  const poster = await createPoster(
    {
      allowlistedTags: allowlist,
      chainId: 1,
      bamCoreAddress: BAM_CORE,
      signer,
      store: createMemoryStore(),
      batchPolicy: (await import('../../src/index.js')).defaultBatchPolicy({ forceFlush: true }),
    },
    extras
  );
  const internal = poster as unknown as {
    _tickTag: (tag: Bytes32) => Promise<void>;
    _tickReorgWatcher: () => Promise<{ reorgedCount: number; keptCount: number }>;
  };
  return {
    poster,
    chain,
    submittedCalls,
    nextTxId,
    tickTag: internal._tickTag,
    tickReorg: internal._tickReorgWatcher,
  };
}

async function signedEnvelope(
  tag: Bytes32,
  nonce: number,
  content: string,
  privateKey?: `0x${string}`
): Promise<Uint8Array> {
  const pk = (privateKey ?? generateECDSAPrivateKey()) as `0x${string}`;
  const author = privateKeyToAccount(pk).address as Address;
  const timestamp = 1_700_000_000;
  const hash = computeMessageHash({ author, timestamp, nonce, content });
  const sig = await signECDSA(pk, bytesToHex(hash) as Bytes32);
  return new TextEncoder().encode(
    JSON.stringify({
      contentTag: tag,
      message: { author, timestamp, nonce, content, signature: bytesToHex(sig) },
    })
  );
}

describe('Full-cycle integration', () => {
  beforeEach(() => _clearSignerRegistryForTests());

  it('ingest → pending → submit → confirmed → reorg → resubmit', async () => {
    const h = await makeHarness([TAG_A, TAG_B]);

    // Ingest three messages across two tags (distinct signers so nonces
    // don't collide against the shared per-author monotonicity rule).
    const pkA = generateECDSAPrivateKey() as `0x${string}`;
    const pkB = generateECDSAPrivateKey() as `0x${string}`;
    const rawA1 = await signedEnvelope(TAG_A, 1, 'a1', pkA);
    const rawA2 = await signedEnvelope(TAG_A, 2, 'a2', pkA);
    const rawB1 = await signedEnvelope(TAG_B, 1, 'b1', pkB);

    expect((await h.poster.submit(rawA1)).accepted).toBe(true);
    expect((await h.poster.submit(rawA2)).accepted).toBe(true);
    expect((await h.poster.submit(rawB1)).accepted).toBe(true);

    // Pending view per tag.
    const pendingA = await h.poster.listPending({ contentTag: TAG_A });
    const pendingB = await h.poster.listPending({ contentTag: TAG_B });
    expect(pendingA.map((m) => m.content)).toEqual(['a1', 'a2']);
    expect(pendingB.map((m) => m.content)).toEqual(['b1']);

    // Trigger submission for tag A.
    await h.tickTag(TAG_A);
    expect(h.submittedCalls).toHaveLength(1);
    expect(h.submittedCalls[0].tag).toBe(TAG_A);
    expect(h.submittedCalls[0].messageIds).toHaveLength(2);

    // On inclusion: pending A pruned, tag B untouched.
    expect(await h.poster.listPending({ contentTag: TAG_A })).toHaveLength(0);
    expect(await h.poster.listPending({ contentTag: TAG_B })).toHaveLength(1);

    // listSubmittedBatches exposes the included batch.
    const after = await h.poster.listSubmittedBatches({ contentTag: TAG_A });
    expect(after).toHaveLength(1);
    expect(after[0].status).toBe('included');
    const originalTx = after[0].txHash;

    // Simulate reorg: tag A's tx is no longer on canonical chain.
    h.chain.head += 5n;
    h.chain.reorg(originalTx);
    const reorgResult = await h.tickReorg();
    expect(reorgResult.reorgedCount).toBe(1);

    // Messages are back in pending.
    const repending = await h.poster.listPending({ contentTag: TAG_A });
    expect(repending).toHaveLength(2);
    expect(repending.map((m) => m.content)).toEqual(['a1', 'a2']);

    // Resubmit.
    await h.tickTag(TAG_A);
    expect(h.submittedCalls).toHaveLength(2);

    // The reorged batch is visible + marked reorged; the new one is included.
    const final = await h.poster.listSubmittedBatches({ contentTag: TAG_A });
    expect(final.map((f) => f.status).sort()).toEqual(['included', 'reorged']);

    // Tag B is undisturbed.
    expect(await h.poster.listPending({ contentTag: TAG_B })).toHaveLength(1);

    await h.poster.stop();
  });
});
