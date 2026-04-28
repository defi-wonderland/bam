/**
 * Canonical-dispatch end-to-end test.
 *
 * Acceptance-criteria matrix:
 *
 *   - default          → decoder=0x0, registry=0x0; SDK fast-path
 *                        for both decode and verify; counters
 *                        decoded↑ / skipped*=0.
 *   - canonical-registry → decoder=0x0, registry=ECDSARegistry;
 *                          SDK decode, on-chain verify.
 *   - canonical-full   → decoder=ABIDecoder, registry=ECDSARegistry;
 *                        on-chain decode AND on-chain verify.
 *
 * In every configuration the resulting `MessageRow` count is unchanged.
 * The non-zero configurations also assert that real `eth_call`s went
 * out against the named contracts via the fixture's RPC tap.
 *
 * Skipping policy: relies on `anvil` being on PATH. If it isn't, the
 * test suite skips at fixture-init time so `pnpm test:run` stays
 * hermetic in environments without foundry.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { decodeBatchABI } from 'bam-sdk';

import {
  setupAnvil,
  deployContracts,
  runScenario,
  type AnvilHandle,
  type DeployedContracts,
} from './_fixture.js';

let anvilAvailable = true;
let anvil: AnvilHandle | null = null;
let deployments: DeployedContracts | null = null;

beforeAll(async () => {
  try {
    anvil = await setupAnvil();
    deployments = await deployContracts(anvil.rpcUrl);
  } catch (err) {
    anvilAvailable = false;
    if (anvil) await anvil.stop().catch(() => undefined);
    anvil = null;
    deployments = null;
    // Surface why we're skipping; helpful when debugging CI.
    process.stderr.write(
      `[canonical-dispatch.test] skipping suite — fixture init failed: ${
        err instanceof Error ? err.message : String(err)
      }\n`
    );
  }
}, 30_000);

afterAll(async () => {
  if (anvil) await anvil.stop();
});

describe.skipIf(!anvilAvailable)('canonical-dispatch e2e', () => {
  it('default profile → counters advance, addresses zero, no eth_calls', async () => {
    if (!anvil || !deployments) throw new Error('fixture not initialized');
    const result = await runScenario({
      profile: 'default',
      rpcUrl: anvil.rpcUrl,
      chainId: anvil.chainId,
      deployments,
    });
    expect(result.counters.decoded).toBe(2);
    expect(result.counters.skippedDecode).toBe(0);
    expect(result.counters.skippedVerify).toBe(0);
    expect(result.batchRows.length).toBe(1);
    expect(result.batchRows[0].decoderNamed.toLowerCase()).toBe(
      '0x0000000000000000000000000000000000000000'
    );
    expect(result.batchRows[0].signatureRegistryNamed.toLowerCase()).toBe(
      '0x0000000000000000000000000000000000000000'
    );
    expect(result.messageRows).toBe(2);
    // SDK fast path on both sides → no `eth_call` against any deployed
    // contract should fire under default.
    expect(result.rpcTap.ethCalls.length).toBe(0);
  });

  it('canonical-registry profile → registry non-zero, eth_call against ECDSARegistry observed', async () => {
    if (!anvil || !deployments) throw new Error('fixture not initialized');
    const result = await runScenario({
      profile: 'canonical-registry',
      rpcUrl: anvil.rpcUrl,
      chainId: anvil.chainId,
      deployments,
    });
    expect(result.counters.decoded).toBe(2);
    expect(result.counters.skippedDecode).toBe(0);
    expect(result.counters.skippedVerify).toBe(0);
    expect(result.batchRows.length).toBe(1);
    expect(result.batchRows[0].decoderNamed.toLowerCase()).toBe(
      '0x0000000000000000000000000000000000000000'
    );
    expect(result.batchRows[0].signatureRegistryNamed.toLowerCase()).toBe(
      deployments.ecdsaRegistry.toLowerCase()
    );
    expect(result.messageRows).toBe(2);

    // The Reader's verify dispatch fired at least one `eth_call` against
    // the named registry (per-message verify). The decoder side stayed
    // off-chain, so no `eth_call` against ABIDecoder.
    const calls = result.rpcTap.ethCalls.map((c) => c.to.toLowerCase());
    expect(calls).toContain(deployments.ecdsaRegistry.toLowerCase());
    expect(calls).not.toContain(deployments.abiDecoder.toLowerCase());
  });

  it('canonical-full profile → both addresses non-zero, eth_calls against both, blob round-trips via decodeBatchABI', async () => {
    if (!anvil || !deployments) throw new Error('fixture not initialized');
    const result = await runScenario({
      profile: 'canonical-full',
      rpcUrl: anvil.rpcUrl,
      chainId: anvil.chainId,
      deployments,
    });
    expect(result.counters.decoded).toBe(2);
    expect(result.counters.skippedDecode).toBe(0);
    expect(result.counters.skippedVerify).toBe(0);
    expect(result.batchRows.length).toBe(1);
    expect(result.batchRows[0].decoderNamed.toLowerCase()).toBe(
      deployments.abiDecoder.toLowerCase()
    );
    expect(result.batchRows[0].signatureRegistryNamed.toLowerCase()).toBe(
      deployments.ecdsaRegistry.toLowerCase()
    );
    expect(result.messageRows).toBe(2);

    // Both decoder and registry contracts were queried by the Reader.
    const calls = result.rpcTap.ethCalls.map((c) => c.to.toLowerCase());
    expect(calls).toContain(deployments.abiDecoder.toLowerCase());
    expect(calls).toContain(deployments.ecdsaRegistry.toLowerCase());

    // Sanity: the Poster (test simulation) encoded the batch with the
    // ABI codec. Re-decoding the captured payload via `decodeBatchABI`
    // returns 2 messages, confirming the canonical-full path was used.
    const round = decodeBatchABI(result.encodedPayload);
    expect(round.messages.length).toBe(2);
  });
});
