import { afterEach, describe, expect, it } from 'vitest';
import {
  encodeContents,
  signECDSAWithKey,
  type Address,
  type BAMMessage,
  type Bytes32,
} from 'bam-sdk';

import {
  createPoster,
  _clearSignerRegistryForTests,
  LocalEcdsaSigner,
  defaultBatchPolicy,
  type InternalPoster,
} from '../../src/index.js';
import type { BuildAndSubmit, SubmitOutcome } from '../../src/submission/types.js';
import type { BlockSource } from '../../src/submission/reorg-watcher.js';
import type { ReconcileRpcClient } from '../../src/startup/reconcile.js';
import type { StatusRpcReader } from '../../src/surfaces/status.js';

/**
 * Integration: ingest → pool → flush → reorg, exercised end-to-end
 * through the public factory with the submission loop + reorg watcher
 * driven manually via `InternalPoster` hooks. Replaces the deleted
 * full-cycle coverage.
 */

const CHAIN_ID = 31337;
const PRIV = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const SENDER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as Address;
const TAG = ('0x' + 'aa'.repeat(32)) as Bytes32;
const BAM_CORE = ('0x' + '22'.repeat(20)) as Address;
const TX_A = ('0x' + '01'.repeat(32)) as Bytes32;
const BVH_A = ('0x' + '02'.repeat(32)) as Bytes32;

const posters: InternalPoster[] = [];

afterEach(async () => {
  for (const p of posters.splice(0)) await p.stop();
  _clearSignerRegistryForTests();
});

function bytesToHex(b: Uint8Array): `0x${string}` {
  return ('0x' +
    Array.from(b)
      .map((x) => x.toString(16).padStart(2, '0'))
      .join('')) as `0x${string}`;
}

function signedEnvelope(nonce: bigint): Uint8Array {
  const contents = encodeContents(TAG, new TextEncoder().encode('x'));
  const msg: BAMMessage = { sender: SENDER, nonce, contents };
  const signature = signECDSAWithKey(PRIV, msg, CHAIN_ID);
  return new TextEncoder().encode(
    JSON.stringify({
      contentTag: TAG,
      message: {
        sender: SENDER,
        nonce: nonce.toString(),
        contents: bytesToHex(contents),
        signature,
      },
    })
  );
}

interface RpcCtl {
  /** Which txHashes the chain no longer contains (simulates reorg). */
  reorgedTxs: Set<Bytes32>;
  /** Head block, advanced explicitly by the test. */
  head: bigint;
}

function mkRpc(ctl: RpcCtl): ReconcileRpcClient & StatusRpcReader & BlockSource {
  return {
    async getChainId() {
      return CHAIN_ID;
    },
    async getCode(_address: Address) {
      return '0x6060604052' as `0x${string}`;
    },
    async getBalance() {
      return 10n ** 18n;
    },
    async getBlockNumber() {
      return ctl.head;
    },
    async getTransactionBlock(txHash) {
      if (ctl.reorgedTxs.has(txHash)) return null;
      return 100;
    },
  };
}

function mkBuildAndSubmit(outcomes: SubmitOutcome[]): {
  fn: BuildAndSubmit;
  calls: number;
} {
  let i = 0;
  const state = { calls: 0 };
  const fn: BuildAndSubmit = async () => {
    state.calls++;
    return outcomes[Math.min(i++, outcomes.length - 1)];
  };
  return { fn, calls: state.calls };
}

async function makePoster(
  buildAndSubmit: BuildAndSubmit,
  rpc: ReconcileRpcClient & StatusRpcReader & BlockSource
): Promise<InternalPoster> {
  // Use headless signer with a different key so the factory's "same
  // signer already configured" guard isn't upset across tests.
  const signer = new LocalEcdsaSigner(
    '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
  );
  const poster = (await createPoster(
    {
      allowlistedTags: [TAG],
      chainId: CHAIN_ID,
      bamCoreAddress: BAM_CORE,
      signer,
      batchPolicy: defaultBatchPolicy({ forceFlush: true }),
      reorgWindowBlocks: 4,
      now: () => new Date(5_000),
    },
    { buildAndSubmit, rpc }
  )) as InternalPoster;
  posters.push(poster);
  return poster;
}

describe('createPoster — full ingest → submit cycle', () => {
  it('ingest → listPending → tick → submitted-batches reflects inclusion', async () => {
    const ctl: RpcCtl = { reorgedTxs: new Set(), head: 110n };
    const bas = mkBuildAndSubmit([
      { kind: 'included', txHash: TX_A, blockNumber: 100, blobVersionedHash: BVH_A },
    ]);
    const poster = await makePoster(bas.fn, mkRpc(ctl));

    const result = await poster.submit(signedEnvelope(1n));
    expect(result.accepted).toBe(true);

    const pendingBefore = await poster.listPending({ contentTag: TAG });
    expect(pendingBefore.length).toBe(1);

    await poster._tickTag(TAG);

    const pendingAfter = await poster.listPending({ contentTag: TAG });
    expect(pendingAfter.length).toBe(0);

    const submitted = await poster.listSubmittedBatches({ contentTag: TAG });
    expect(submitted.length).toBe(1);
    expect(submitted[0].status).toBe('included');
    expect(submitted[0].messages[0].messageId).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('reorg within window → submitted row flips to reorged + invalidatedAt', async () => {
    const ctl: RpcCtl = { reorgedTxs: new Set(), head: 100n };
    const bas = mkBuildAndSubmit([
      { kind: 'included', txHash: TX_A, blockNumber: 100, blobVersionedHash: BVH_A },
    ]);
    const poster = await makePoster(bas.fn, mkRpc(ctl));

    await poster.submit(signedEnvelope(1n));
    await poster._tickTag(TAG);

    // Simulate a reorg: tx A vanishes from canonical chain; head advances.
    ctl.reorgedTxs.add(TX_A);
    ctl.head = 103n;
    await poster._tickReorgWatcher();

    const submitted = await poster.listSubmittedBatches({ contentTag: TAG });
    expect(submitted[0].status).toBe('reorged');
    expect(submitted[0].invalidatedAt).not.toBeNull();
    // After reorg, per-message messageId is surfaced as null.
    for (const m of submitted[0].messages) expect(m.messageId).toBeNull();

    // And the pending pool has the message back.
    const pending = await poster.listPending({ contentTag: TAG });
    expect(pending.length).toBe(1);
  });

  it('health() is "ok" after a clean tick; status() reports zero pending', async () => {
    const ctl: RpcCtl = { reorgedTxs: new Set(), head: 110n };
    const bas = mkBuildAndSubmit([
      { kind: 'included', txHash: TX_A, blockNumber: 100, blobVersionedHash: BVH_A },
    ]);
    const poster = await makePoster(bas.fn, mkRpc(ctl));
    await poster.submit(signedEnvelope(1n));
    await poster._tickTag(TAG);
    const h = await poster.health();
    expect(h.state).toBe('ok');
    const s = await poster.status();
    expect(s.pendingByTag[0].count).toBe(0);
    expect(s.lastSubmittedByTag[0].txHash).toBe(TX_A);
  });
});
