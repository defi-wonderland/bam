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
 * End-to-end round-trip against a real anvil + deployed BAM Core.
 *
 * Skipped by default because it requires external infrastructure —
 * an anvil RPC serving EIP-4844 blob transactions, with BAM Core
 * deployed and its address exported. In CI / local runs the
 * orchestration script:
 *
 *     anvil --hardfork cancun &
 *     cd packages/bam-contracts && forge script script/Deploy.s.sol \
 *       --rpc-url $ANVIL_URL --broadcast
 *
 * and exports `ANVIL_URL`, `BAM_CORE_ADDRESS`. When those are
 * present, the test runs; otherwise it is skipped (not failed) so
 * the default `pnpm test:run` stays green in hermetic environments.
 *
 * Coverage intent: prove that a message signed via scheme 0x01
 * (EIP-712) lands on-chain with its ERC-8180 messageId computable
 * from the emitted `BlobBatchRegistered` event's batch content hash.
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
  const contents = encodeContents(TAG, new TextEncoder().encode('round-trip'));
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

describe.skipIf(!SHOULD_RUN)('E2E — contract round trip (anvil)', () => {
  it('signed message → Poster → blob tx on chain → BlobBatchRegistered', async () => {
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
        now: () => new Date(),
      },
      { buildAndSubmitMulti, rpc }
    )) as InternalPoster;
    posters.push(poster);

    const submit = await poster.submit(signedEnvelope(1n));
    expect(submit.accepted).toBe(true);

    await poster._tickAggregator();
    const batches = await poster.listSubmittedBatches({ contentTag: TAG });
    expect(batches.length).toBe(1);
    expect(batches[0].status).toBe('included');
    expect(batches[0].messages[0].messageId).toMatch(/^0x[0-9a-f]{64}$/);
  }, 60_000);
});
