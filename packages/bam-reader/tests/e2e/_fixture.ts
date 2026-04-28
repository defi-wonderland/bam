/**
 * Canonical-dispatch e2e fixture.
 *
 * Spins up an isolated anvil instance, deploys `ECDSARegistry` and
 * `ABIDecoder` against it (via the forge-built artifacts under
 * `packages/bam-contracts/out/`), and exposes a `runScenario(profile)`
 * helper that exercises the Reader's `processBatch` end-to-end:
 *
 *   - The Poster path is *simulated*: the test encodes a batch via the
 *     codec the profile names (binary for `default`/`canonical-registry`,
 *     ABI for `canonical-full`), packs it into a blob, and constructs a
 *     synthetic `BlobBatchRegistered` event.
 *   - The Reader path is *real*: it consumes the synthetic event, fetches
 *     the blob via the test's `fetchBlob` injector, then runs the actual
 *     `decode/dispatch.ts` and `verify/dispatch.ts` modules — which, for
 *     non-zero addresses, perform real `eth_call`s against the deployed
 *     contracts on anvil.
 *
 * Skipping: if `anvil` isn't on PATH, `setupAnvil` throws and the
 * caller-side `describe.skipIf` opts the suite out so the default
 * `pnpm test:run` stays hermetic in environments without foundry.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import {
  encodeBatch,
  encodeBatchABI,
  encodeContents,
  generateECDSAPrivateKey,
  deriveAddress,
  hexToBytes,
  signECDSAWithKey,
  createBlob,
  commitToBlob,
  loadTrustedSetup,
  type Address,
  type BAMMessage,
  type Bytes32,
} from 'bam-sdk';
import {
  createPublicClient,
  createWalletClient,
  http,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createMemoryStore, type BamStore } from 'bam-store';

import { processBatch, emptyCounters } from '../../src/loop/process-batch.js';
import type { BlobBatchRegisteredEvent } from '../../src/discovery/log-scan.js';
import type { ReaderCounters } from '../../src/types.js';
import type { ReadContractClient } from '../../src/decode/on-chain-decoder.js';
import type { VerifyReadContractClient } from '../../src/verify/on-chain-registry.js';

// Anvil's default deterministic key #0.
const DEPLOYER_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as `0x${string}`;

const CONTRACTS_OUT = join(
  // The poster/reader builds run from packages/<pkg>; resolve up to the
  // workspace root and then back into bam-contracts.
  new URL('../../../bam-contracts/out', import.meta.url).pathname
);

function readArtifact(name: string): { abi: unknown[]; bytecode: `0x${string}` } {
  const path = join(CONTRACTS_OUT, `${name}.sol`, `${name}.json`);
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as {
    abi: unknown[];
    bytecode: { object: `0x${string}` };
  };
  return { abi: raw.abi, bytecode: raw.bytecode.object };
}

export interface AnvilHandle {
  rpcUrl: string;
  chainId: number;
  stop(): Promise<void>;
}

export async function setupAnvil(): Promise<AnvilHandle> {
  // Sanity-check that anvil is reachable; surface a clear error so the
  // caller's `describe.skipIf` can make a binary decision.
  const probe = spawnSync('anvil', ['--version'], { encoding: 'utf-8' });
  if (probe.status !== 0) {
    throw new Error('anvil not on PATH (foundry not installed?)');
  }

  // Pick a port unlikely to collide with the developer's running anvil.
  const port = 18550 + Math.floor(Math.random() * 1000);
  const proc: ChildProcess = spawn(
    'anvil',
    ['--port', String(port), '--silent', '--hardfork', 'cancun', '--chain-id', '31337'],
    { stdio: ['ignore', 'ignore', 'ignore'] }
  );

  const rpcUrl = `http://127.0.0.1:${port}`;

  // Poll until anvil starts accepting JSON-RPC. anvil --silent doesn't
  // emit a "ready" line on stdout, so we just probe `eth_chainId`.
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_chainId', params: [], id: 1 }),
      });
      if (r.ok) {
        const json = (await r.json()) as { result?: string };
        if (json.result) break;
      }
    } catch {
      // not ready yet
    }
    await delay(50);
  }
  if (Date.now() >= deadline) {
    proc.kill('SIGKILL');
    throw new Error(`anvil did not become ready on ${rpcUrl} within 8s`);
  }

  return {
    rpcUrl,
    chainId: 31337,
    async stop() {
      proc.kill('SIGKILL');
      await new Promise<void>((resolve) => {
        if (proc.exitCode !== null) return resolve();
        proc.once('exit', () => resolve());
        // Hard cap so a stuck child can't leak the test runner.
        setTimeout(() => resolve(), 500);
      });
    },
  };
}

export interface DeployedContracts {
  ecdsaRegistry: Address;
  abiDecoder: Address;
}

export async function deployContracts(
  rpcUrl: string,
  deployerKey: `0x${string}` = DEPLOYER_KEY
): Promise<DeployedContracts> {
  const account = privateKeyToAccount(deployerKey);
  const wallet: WalletClient = createWalletClient({
    account,
    transport: http(rpcUrl),
  });
  const publicClient: PublicClient = createPublicClient({
    transport: http(rpcUrl),
  });

  const ecdsaArt = readArtifact('ECDSARegistry');
  const abiArt = readArtifact('ABIDecoder');

  const ecdsaTx = await wallet.deployContract({
    abi: ecdsaArt.abi as never,
    bytecode: ecdsaArt.bytecode,
    account,
    chain: null,
  });
  const ecdsaReceipt = await publicClient.waitForTransactionReceipt({ hash: ecdsaTx });
  if (!ecdsaReceipt.contractAddress) throw new Error('ECDSARegistry deploy: no contractAddress');

  const abiTx = await wallet.deployContract({
    abi: abiArt.abi as never,
    bytecode: abiArt.bytecode,
    account,
    chain: null,
  });
  const abiReceipt = await publicClient.waitForTransactionReceipt({ hash: abiTx });
  if (!abiReceipt.contractAddress) throw new Error('ABIDecoder deploy: no contractAddress');

  return {
    ecdsaRegistry: ecdsaReceipt.contractAddress as Address,
    abiDecoder: abiReceipt.contractAddress as Address,
  };
}

/**
 * Track every JSON-RPC `eth_call` made during a scenario so the test can
 * assert which deployed addresses the Reader actually queried.
 */
export interface RpcTap {
  ethCalls: { to: Address; data: `0x${string}` }[];
}

function makeTappedClient(rpcUrl: string, tap: RpcTap): PublicClient {
  const pc = createPublicClient({
    transport: http(rpcUrl, {
      // `onFetchRequest` lets us observe every JSON-RPC request without
      // having to swap out the fetch implementation entirely.
      onFetchRequest(request) {
        const body = (request as Request & { body?: unknown }).body;
        // The Request body in node-fetch / undici is a stream; viem
        // serializes JSON to body, but the simplest portable path is to
        // sniff the request via `request.text()`. Since this is
        // test-only, await an explicit clone.
        request
          .clone()
          .text()
          .then((text) => {
            try {
              const parsed = JSON.parse(text) as
                | { method?: string; params?: unknown }
                | { method?: string; params?: unknown }[];
              const requests = Array.isArray(parsed) ? parsed : [parsed];
              for (const r of requests) {
                if (r.method === 'eth_call' && Array.isArray(r.params) && r.params.length >= 1) {
                  const callObj = r.params[0] as { to?: Address; data?: `0x${string}` };
                  if (callObj.to && callObj.data) {
                    tap.ethCalls.push({ to: callObj.to, data: callObj.data });
                  }
                }
              }
            } catch {
              // non-JSON body, ignore
            }
          })
          .catch(() => undefined);
        void body;
      },
    }),
  });
  return pc;
}

export type Profile = 'default' | 'canonical-registry' | 'canonical-full';

interface ScenarioResult {
  counters: ReaderCounters;
  /**
   * One entry per `BatchRow` substrate-side. The substrate doesn't store
   * `decoder` / `signatureRegistry` — those are *event* fields the Reader
   * dispatches on. We surface them here for assertion-side convenience
   * (the test asserts what the Poster named on L1, which is exactly what
   * the synthetic event carried).
   */
  batchRows: { decoderNamed: Address; signatureRegistryNamed: Address }[];
  messageRows: number;
  rpcTap: RpcTap;
  /** Raw encoded batch bytes (pre-blob-pad) so the test can re-decode. */
  encodedPayload: Uint8Array;
}

const TAG = ('0x' + 'aa'.repeat(32)) as Bytes32;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;
const TX_HASH = ('0x' + '01'.repeat(32)) as Bytes32;

interface SignedMessage {
  message: BAMMessage;
  signature: Uint8Array;
}

function makeSignedMessage(nonce: bigint, payload: Uint8Array, chainId: number): SignedMessage {
  const priv = generateECDSAPrivateKey() as `0x${string}`;
  const sender = deriveAddress(priv);
  const contents = encodeContents(TAG, payload);
  const message: BAMMessage = { sender, nonce, contents };
  const sigHex = signECDSAWithKey(priv, message, chainId);
  return { message, signature: hexToBytes(sigHex) };
}

export interface RunScenarioOptions {
  profile: Profile;
  rpcUrl: string;
  chainId: number;
  deployments: DeployedContracts;
  store?: BamStore;
}

let trustedSetupLoaded = false;
function ensureTrustedSetup(): void {
  if (!trustedSetupLoaded) {
    loadTrustedSetup();
    trustedSetupLoaded = true;
  }
}

export async function runScenario(opts: RunScenarioOptions): Promise<ScenarioResult> {
  ensureTrustedSetup();
  const { profile, rpcUrl, chainId, deployments } = opts;
  const store = opts.store ?? createMemoryStore();
  const tap: RpcTap = { ethCalls: [] };
  const tappedClient = makeTappedClient(rpcUrl, tap);

  // Choose addresses + encoder per profile (matches the Poster's
  // `resolveProfileAddresses` + encoder selection).
  let decoderAddress: Address;
  let signatureRegistryAddress: Address;
  let encoded: Uint8Array;

  const m1 = makeSignedMessage(1n, new Uint8Array([0x01]), chainId);
  const m2 = makeSignedMessage(2n, new Uint8Array([0x02]), chainId);
  const messages = [m1.message, m2.message];
  const signatures = [m1.signature, m2.signature];

  switch (profile) {
    case 'default':
      decoderAddress = ZERO_ADDRESS;
      signatureRegistryAddress = ZERO_ADDRESS;
      encoded = encodeBatch(messages, signatures).data;
      break;
    case 'canonical-registry':
      decoderAddress = ZERO_ADDRESS;
      signatureRegistryAddress = deployments.ecdsaRegistry;
      encoded = encodeBatch(messages, signatures).data;
      break;
    case 'canonical-full':
      decoderAddress = deployments.abiDecoder;
      signatureRegistryAddress = deployments.ecdsaRegistry;
      encoded = encodeBatchABI(messages, signatures);
      break;
  }

  const blob = createBlob(encoded);
  const { versionedHash } = commitToBlob(blob);

  const event: BlobBatchRegisteredEvent = {
    blockNumber: 1,
    txIndex: 0,
    logIndex: 0,
    txHash: TX_HASH,
    versionedHash,
    submitter: ('0x' + '11'.repeat(20)) as Address,
    contentTag: TAG,
    decoder: decoderAddress,
    signatureRegistry: signatureRegistryAddress,
  };

  const counters = emptyCounters();
  await processBatch({
    event,
    parentBeaconBlockRoot: null,
    store,
    sources: {},
    chainId,
    ethCallGasCap: 50_000_000n,
    ethCallTimeoutMs: 5_000,
    counters,
    fetchBlob: async () => blob,
    decodePublicClient: tappedClient as ReadContractClient,
    verifyPublicClient: tappedClient as VerifyReadContractClient,
  });

  const batches = await store.withTxn(async (txn) => txn.listBatches({ chainId }));
  const rows = await store.withTxn(async (txn) => txn.listMessages({ contentTag: TAG }));

  return {
    counters,
    batchRows: batches.map(() => ({
      decoderNamed: decoderAddress,
      signatureRegistryNamed: signatureRegistryAddress,
    })),
    messageRows: rows.length,
    rpcTap: tap,
    encodedPayload: encoded,
  };
}
