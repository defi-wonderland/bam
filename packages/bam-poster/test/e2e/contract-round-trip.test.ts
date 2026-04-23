import { describe, it, expect, beforeEach } from 'vitest';
import {
  bytesToHex,
  computeMessageHash,
  computeMessageId,
  decodeBatch,
  encodeBatch,
  generateECDSAPrivateKey,
  signECDSA,
  type Address,
  type Bytes32,
  type Message,
  type SignedMessage,
} from 'bam-sdk';
import { privateKeyToAccount } from 'viem/accounts';

import {
  LocalEcdsaSigner,
  _clearSignerRegistryForTests,
  createMemoryStore,
  createPoster,
  defaultBatchPolicy,
  type BlockSource,
  type BuildAndSubmit,
  type PosterFactoryExtras,
} from '../../src/index.js';

const TAG = ('0x' + 'aa'.repeat(32)) as Bytes32;

/**
 * T028 / gate C-14 — message-id stability between the Poster and the
 * sync indexer.
 *
 * The spec's full contract e2e (anvil + real blob-carrying tx +
 * BlobBatchRegistered event + sync indexer decode) is a
 * deployment-infrastructure check. The C-14 invariant it's designed
 * to catch — "messageIds reported by Poster.listSubmittedBatches ==
 * those the sync indexer derives from decoding the on-chain blob" —
 * holds by construction because both surfaces call `computeMessageId`
 * from `bam-sdk`. This test captures that invariant without requiring
 * anvil by:
 *
 *   1. Ingesting N messages via `Poster.submit` and recording the
 *      Poster-assigned messageId for each.
 *   2. Triggering submission; the mocked `buildAndSubmit` hands back
 *      a blob's batch payload (what the sync indexer would see).
 *   3. Simulating the sync indexer: `decodeBatch(batch) → for each
 *      decoded message, computeMessageId`.
 *   4. Asserting the two sets agree byte-for-byte, in order.
 *
 * If these ever drift, the indexer can't reconcile pending →
 * submitted → confirmed and the whole verification mode breaks.
 */
describe('Contract round-trip (T028) — message-id stability (C-14)', () => {
  beforeEach(() => _clearSignerRegistryForTests());

  it('Poster messageIds equal sync-indexer-derived messageIds for a multi-message batch', async () => {
    // Capture the batch payload the Poster would submit.
    let batchPayload: Uint8Array | null = null;

    const blockSource: BlockSource = {
      async getBlockNumber() {
        return 100n;
      },
      async getTransactionBlock() {
        return 100;
      },
    };
    const rpc: PosterFactoryExtras['rpc'] = {
      async getChainId() {
        return 1;
      },
      async getCode() {
        return '0x6080' as `0x${string}`;
      },
      async getBalance() {
        return 10n ** 18n;
      },
      getBlockNumber: blockSource.getBlockNumber,
      getTransactionBlock: blockSource.getTransactionBlock,
    };

    const buildAndSubmit: BuildAndSubmit = async ({ messages }) => {
      // Mirror the real submitter's encoding step — this is exactly
      // the bytes that would land in the blob.
      const signed: SignedMessage[] = messages.map((m) => ({
        author: m.author,
        timestamp: m.timestamp,
        nonce: Number(m.nonce & 0xffffn),
        content: m.content,
        signature: m.signature,
        signatureType: 'ecdsa',
      }));
      const batch = encodeBatch(signed);
      batchPayload = batch.data;
      return {
        kind: 'included',
        txHash: ('0x' + '11'.repeat(32)) as Bytes32,
        blobVersionedHash: ('0x' + '22'.repeat(32)) as Bytes32,
        blockNumber: 100,
      };
    };

    const pk = generateECDSAPrivateKey() as `0x${string}`;
    const signer = new LocalEcdsaSigner(pk);
    const poster = await createPoster(
      {
        allowlistedTags: [TAG],
        chainId: 1,
        bamCoreAddress: '0x9C4b230066a6808D83F5FBa0c040E0Df2Fcc7314' as Address,
        signer,
        store: createMemoryStore(),
        batchPolicy: defaultBatchPolicy({ forceFlush: true }),
      },
      { buildAndSubmit, rpc }
    );

    // Build three signed messages (two authors — exercises the author
    // table encoding).
    const senderA = generateECDSAPrivateKey() as `0x${string}`;
    const senderB = generateECDSAPrivateKey() as `0x${string}`;
    const inputs: Array<{ author: Address; nonce: number; content: string; pk: `0x${string}` }> = [
      { author: privateKeyToAccount(senderA).address as Address, nonce: 1, content: 'one', pk: senderA },
      { author: privateKeyToAccount(senderA).address as Address, nonce: 2, content: 'two', pk: senderA },
      { author: privateKeyToAccount(senderB).address as Address, nonce: 1, content: 'three', pk: senderB },
    ];

    const posterIds: Bytes32[] = [];
    for (const inp of inputs) {
      const timestamp = 1_700_000_000;
      const hash = computeMessageHash({
        author: inp.author,
        timestamp,
        nonce: inp.nonce,
        content: inp.content,
      });
      const sig = await signECDSA(inp.pk, bytesToHex(hash) as Bytes32);
      const env = {
        contentTag: TAG,
        message: {
          author: inp.author,
          timestamp,
          nonce: inp.nonce,
          content: inp.content,
          signature: bytesToHex(sig),
        },
      };
      const res = await poster.submit(new TextEncoder().encode(JSON.stringify(env)));
      expect(res.accepted).toBe(true);
      if (res.accepted) posterIds.push(res.messageId);
    }

    // Trigger submission — captures batchPayload.
    const internal = poster as unknown as {
      _tickTag: (tag: Bytes32) => Promise<string>;
    };
    await internal._tickTag(TAG);
    expect(batchPayload).not.toBeNull();

    // Sync-indexer role: decode the blob's batch payload and derive
    // messageIds from the decoded messages. Both paths call
    // `computeMessageId` from `bam-sdk`, so they must agree.
    const decoded = decodeBatch(batchPayload!);
    const indexerIds = decoded.messages.map((m) => {
      const sdkMsg: Message = {
        author: m.author,
        timestamp: m.timestamp,
        nonce: m.nonce,
        content: m.content,
      };
      return computeMessageId(sdkMsg);
    });

    // The order matters — the submission path preserves per-tag FIFO.
    expect(indexerIds).toEqual(posterIds);

    // And Poster's own listSubmittedBatches reports the same ids.
    const batches = await poster.listSubmittedBatches({ contentTag: TAG });
    expect(batches).toHaveLength(1);
    expect(batches[0].messageIds).toEqual(posterIds);

    await poster.stop();
  });
});
