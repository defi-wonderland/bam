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
  defaultBatchPolicy,
  type BlockSource,
  type BuildAndSubmit,
  type PosterFactoryExtras,
} from '../../src/index.js';

const TAG = ('0x' + 'aa'.repeat(32)) as Bytes32;

/**
 * T029 — Reorg e2e. The spec's full anvil_reorg scenario is a
 * deployment-infrastructure check; the invariants it's designed to
 * catch (reorg within window → re-enqueue in original order; new
 * submission links back via `replacedByTxHash`; poster_nonces does
 * not regress) are testable with an in-process block source that
 * flips a tx's inclusion status, which is what this test does.
 */
describe('Reorg e2e (T029)', () => {
  beforeEach(() => _clearSignerRegistryForTests());

  it('submit → include → reorg within window → resubmit → replacedByTxHash chain', async () => {
    const includedTxs = new Map<Bytes32, number | null>();
    let head = 100n;
    let submitCount = 0;

    const blockSource: BlockSource = {
      async getBlockNumber() {
        return head;
      },
      async getTransactionBlock(txHash) {
        const v = includedTxs.get(txHash);
        return v === undefined ? null : v;
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

    const buildAndSubmit: BuildAndSubmit = async () => {
      submitCount++;
      const txHash = (`0x${submitCount.toString(16).padStart(64, '0')}`) as Bytes32;
      includedTxs.set(txHash, Number(head));
      return {
        kind: 'included',
        txHash,
        blobVersionedHash: (`0x${'ff'.repeat(32)}`) as Bytes32,
        blockNumber: Number(head),
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
        reorgWindowBlocks: 32,
      },
      { buildAndSubmit, rpc }
    );

    // Ingest one message + force submission.
    const senderPk = generateECDSAPrivateKey() as `0x${string}`;
    const senderAddr = privateKeyToAccount(senderPk).address as Address;
    const timestamp = 1_700_000_000;
    const nonce = 1;
    const content = 'reorg-me';
    const hash = computeMessageHash({ author: senderAddr, timestamp, nonce, content });
    const sig = await signECDSA(senderPk, bytesToHex(hash) as Bytes32);
    const env = {
      contentTag: TAG,
      message: {
        author: senderAddr,
        timestamp,
        nonce,
        content,
        signature: bytesToHex(sig),
      },
    };

    const submitRes = await poster.submit(new TextEncoder().encode(JSON.stringify(env)));
    expect(submitRes.accepted).toBe(true);
    const ingestedId = submitRes.accepted ? submitRes.messageId : null;

    const internal = poster as unknown as {
      _tickTag: (tag: Bytes32) => Promise<string>;
      _tickReorgWatcher: () => Promise<{ reorgedCount: number; keptCount: number }>;
    };
    await internal._tickTag(TAG);
    const afterSubmit = await poster.listSubmittedBatches({ contentTag: TAG });
    expect(afterSubmit).toHaveLength(1);
    expect(afterSubmit[0].status).toBe('included');
    const originalTxHash = afterSubmit[0].txHash;

    // Simulate reorg: head advances, original tx is no longer on chain.
    head = 110n;
    includedTxs.set(originalTxHash, null);
    const reorg = await internal._tickReorgWatcher();
    expect(reorg.reorgedCount).toBe(1);

    // Message is back in pending.
    const repending = await poster.listPending({ contentTag: TAG });
    expect(repending).toHaveLength(1);
    expect(repending[0].messageId).toBe(ingestedId);

    // poster_nonces doesn't regress: fresh ingest with same nonce still
    // rejects as stale.
    const freshRes = await poster.submit(new TextEncoder().encode(JSON.stringify(env)));
    // Byte-equal retry is a no-op returning the same id (monotonicity
    // helper treats equal `(author, nonce, messageId)` as no-op).
    expect(freshRes.accepted).toBe(true);

    // Resubmit.
    await internal._tickTag(TAG);
    const afterResubmit = await poster.listSubmittedBatches({ contentTag: TAG });
    expect(afterResubmit).toHaveLength(2);
    const included = afterResubmit.find((b) => b.status === 'included');
    const reorged = afterResubmit.find((b) => b.status === 'reorged');
    expect(included).toBeDefined();
    expect(reorged).toBeDefined();
    expect(included!.messageIds).toEqual([ingestedId]);

    // The reorged entry's replacedByTxHash points at the new submission
    // (FU-2). Clients bound to the stale tx hash can follow the chain.
    expect(reorged!.txHash).toBe(originalTxHash);
    expect(reorged!.status).toBe('reorged');
    expect(reorged!.replacedByTxHash).toBe(included!.txHash);

    await poster.stop();
  });
});
