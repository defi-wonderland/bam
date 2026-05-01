import { afterEach, describe, expect, it } from 'vitest';
import { zeroAddress } from 'viem';
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
import { buildAndSubmitWithViem } from '../../src/submission/build-and-submit.js';

/**
 * End-to-end reorg test: submits a batch, drives an `anvil_reorg`
 * RPC call, and confirms the Poster flips the submitted row to
 * `reorged` + re-enqueues the message.
 *
 * Skipped by default — requires an anvil RPC that accepts the
 * `anvil_reorg` method and a deployed BAM Core. See
 * `contract-round-trip.test.ts` for the full environment contract.
 */

const RPC_URL = process.env.ANVIL_URL ?? '';
const BAM_CORE = (process.env.BAM_CORE_ADDRESS ?? '') as Address;
const SHOULD_RUN = RPC_URL !== '' && BAM_CORE !== '';

const CHAIN_ID = 31337;
const PRIV = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const SENDER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as Address;
const TAG = ('0x' + 'aa'.repeat(32)) as Bytes32;

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
  const contents = encodeContents(TAG, new TextEncoder().encode('reorg-test'));
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

async function rpcCall(method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

describe.skipIf(!SHOULD_RUN)('E2E — reorg (anvil_reorg)', () => {
  it('submitted batch gets flipped to reorged + re-enqueued on anvil_reorg', async () => {
    const signer = new LocalEcdsaSigner(
      '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
    );
    const { buildAndSubmitMulti, rpc } = await buildAndSubmitWithViem({
      rpcUrl: RPC_URL,
      chainId: CHAIN_ID,
      bamCoreAddress: BAM_CORE,
      signer,
      decoderAddress: zeroAddress,
    });
    const poster = (await createPoster(
      {
        allowlistedTags: [TAG],
        chainId: CHAIN_ID,
        bamCoreAddress: BAM_CORE,
        signer,
        batchPolicy: defaultBatchPolicy({ forceFlush: true }),
        reorgWindowBlocks: 32,
        now: () => new Date(),
      },
      { buildAndSubmitMulti, rpc }
    )) as InternalPoster;
    posters.push(poster);

    await poster.submit(signedEnvelope(1n));
    await poster._tickAggregator();
    const before = await poster.listSubmittedBatches({ contentTag: TAG });
    expect(before[0].status).toBe('included');
    const includedBlock = before[0].blockNumber!;

    // Drive a reorg. `anvil_reorg` rewinds the chain by N blocks —
    // enough to drop the tx that carried our batch.
    await rpcCall('anvil_reorg', [{ depth: 2, txBlockPairs: [] }]);
    // Mine a fresh block past the reorg so the watcher's head advances.
    await rpcCall('anvil_mine', ['0x5']);

    await poster._tickReorgWatcher();

    const after = await poster.listSubmittedBatches({ contentTag: TAG });
    expect(after[0].status).toBe('reorged');
    expect(after[0].invalidatedAt).not.toBeNull();
    expect(after[0].blockNumber).toBe(includedBlock);
    for (const m of after[0].messages) expect(m.messageId).toBeNull();

    // Message back in pending pool.
    const pending = await poster.listPending({ contentTag: TAG });
    expect(pending.length).toBe(1);
  }, 60_000);
});
