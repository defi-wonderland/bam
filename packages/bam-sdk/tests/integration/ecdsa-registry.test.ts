/**
 * ECDSA registry: SDK-to-contract differential integration test.
 *
 * Runs identical (owner, hash, signature, delegate?) inputs through:
 *   • the SDK's `verifyEcdsaLocal` helper, and
 *   • `ECDSARegistry.verify` / `verifyWithRegisteredKey` on a live anvil,
 * and asserts the two answers agree byte-for-byte. If SDK and contract
 * ever drift, this test catches it.
 *
 * Also asserts the post-deploy invariant that the dispatcher's
 * scheme-0x01 slot points at the deployed registry.
 *
 * Skips (rather than failing) if anvil is not on the PATH — CI is expected
 * to provide it; local developers without Foundry can still run unit tests.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  parseAbiParameters,
  encodeAbiParameters,
  type Address as ViemAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import * as secp from '@noble/secp256k1';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';

import {
  BAMClient,
  deriveAddress,
  verifyEcdsaLocal,
  wrapPersonalSign,
  computeEcdsaPopMessage,
} from '../../src/index.js';
import {
  ECDSA_REGISTRY_ABI,
  SIGNATURE_REGISTRY_DISPATCHER_ABI,
} from '../../src/contracts/abis.js';
import type { Address, Bytes32, HexBytes } from '../../src/index.js';

secp.etc.hmacSha256Sync = (k: Uint8Array, ...m: Uint8Array[]) =>
  hmac(sha256, k, secp.etc.concatBytes(...m));

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONTRACTS_OUT = join(__dirname, '../../../bam-contracts/out');

const ANVIL_RPC = 'http://127.0.0.1:8545';
const DEPLOYER_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const OWNER_KEY =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
const DELEGATE_KEY =
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' as const;

const ANVIL_AVAILABLE = spawnSync('anvil', ['--version'], { stdio: 'ignore' }).status === 0;

function readArtifact(path: string): {
  abi: unknown[];
  bytecode: { object: `0x${string}` };
} {
  const raw = readFileSync(path, 'utf-8');
  return JSON.parse(raw) as {
    abi: unknown[];
    bytecode: { object: `0x${string}` };
  };
}

function privBytes(key: `0x${string}`): Uint8Array {
  return Uint8Array.from(Buffer.from(key.slice(2), 'hex'));
}

function signRaw(key: `0x${string}`, digest: HexBytes): Uint8Array {
  const msg = Uint8Array.from(Buffer.from(digest.slice(2), 'hex'));
  const sig = secp.sign(msg, privBytes(key));
  const compact = sig.toCompactRawBytes();
  const out = new Uint8Array(65);
  out.set(compact, 0);
  out[64] = sig.recovery + 27;
  return out;
}

function bytesToHex(bytes: Uint8Array): `0x${string}` {
  return ('0x' + Buffer.from(bytes).toString('hex')) as `0x${string}`;
}

const describeIf = ANVIL_AVAILABLE ? describe : describe.skip;

describeIf('ECDSA registry SDK-vs-contract differential', () => {
  let anvil: ChildProcess | null = null;
  let client: BAMClient;
  let registryAddress: Address;
  let dispatcherAddress: Address;
  let chainId: number;

  beforeAll(async () => {
    // Boot anvil on 8545 unless one is already there.
    anvil = spawn('anvil', ['--port', '8545', '--silent'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Poll readiness for up to ~8s.
    const publicClient = createPublicClient({ chain: foundry, transport: http(ANVIL_RPC) });
    let ready = false;
    for (let i = 0; i < 40; i++) {
      try {
        await publicClient.getBlockNumber();
        ready = true;
        break;
      } catch {
        await delay(200);
      }
    }
    if (!ready) throw new Error('anvil failed to start');

    const deployer = privateKeyToAccount(DEPLOYER_KEY);
    const walletClient = createWalletClient({
      chain: foundry,
      transport: http(ANVIL_RPC),
      account: deployer,
    });
    chainId = await publicClient.getChainId();

    const dispatcherArtifact = readArtifact(
      join(CONTRACTS_OUT, 'SignatureRegistryDispatcher.sol/SignatureRegistryDispatcher.json')
    );
    const registryArtifact = readArtifact(
      join(CONTRACTS_OUT, 'ECDSARegistry.sol/ECDSARegistry.json')
    );

    // Deploy dispatcher.
    const dispatcherTx = await walletClient.deployContract({
      abi: dispatcherArtifact.abi,
      bytecode: dispatcherArtifact.bytecode.object,
      args: [],
    });
    const dispatcherReceipt = await publicClient.waitForTransactionReceipt({
      hash: dispatcherTx,
    });
    dispatcherAddress = dispatcherReceipt.contractAddress as Address;

    // Deploy registry.
    const registryTx = await walletClient.deployContract({
      abi: registryArtifact.abi,
      bytecode: registryArtifact.bytecode.object,
      args: [],
    });
    const registryReceipt = await publicClient.waitForTransactionReceipt({ hash: registryTx });
    registryAddress = registryReceipt.contractAddress as Address;

    // Atomic-ish: register scheme 0x01.
    const registerTx = await walletClient.writeContract({
      address: dispatcherAddress as `0x${string}`,
      abi: SIGNATURE_REGISTRY_DISPATCHER_ABI,
      functionName: 'registerScheme',
      args: [1, registryAddress as `0x${string}`],
    });
    await publicClient.waitForTransactionReceipt({ hash: registerTx });

    client = new BAMClient({
      chain: foundry,
      rpcUrl: ANVIL_RPC,
      coreAddress: ('0x' + '00'.repeat(20)) as Address,
      account: deployer,
    });
  }, 30_000);

  afterAll(() => {
    if (anvil) {
      anvil.kill('SIGKILL');
    }
  });

  it('post-deploy invariant: dispatcher.registries(0x01) == registry', async () => {
    const claimed = (await client.publicClient.readContract({
      address: dispatcherAddress as `0x${string}`,
      abi: SIGNATURE_REGISTRY_DISPATCHER_ABI,
      functionName: 'registries',
      args: [1],
    })) as ViemAddress;
    expect(claimed.toLowerCase()).toBe(registryAddress.toLowerCase());
  });

  it('keyless verify: SDK and contract agree on happy-path EOA signature', async () => {
    const ownerAddr = deriveAddress(OWNER_KEY);
    const raw = keccak256(Buffer.from('keyless-happy')) as HexBytes;
    const envelope = wrapPersonalSign(raw);
    const sig = signRaw(OWNER_KEY, envelope);

    const sdk = verifyEcdsaLocal({
      owner: ownerAddr,
      hash: envelope,
      signature: sig,
    });
    const chain = await client.verifyEcdsaWithRegisteredKey(
      registryAddress,
      ownerAddr,
      envelope as Bytes32,
      bytesToHex(sig)
    );
    expect(sdk).toBe(true);
    expect(chain).toBe(sdk);
  });

  it('keyless verify: SDK and contract agree on wrong-signer rejection', async () => {
    const ownerAddr = deriveAddress(OWNER_KEY);
    const raw = keccak256(Buffer.from('keyless-wrong')) as HexBytes;
    const envelope = wrapPersonalSign(raw);
    const sig = signRaw(DELEGATE_KEY, envelope); // wrong signer

    const sdk = verifyEcdsaLocal({
      owner: ownerAddr,
      hash: envelope,
      signature: sig,
    });
    const chain = await client.verifyEcdsaWithRegisteredKey(
      registryAddress,
      ownerAddr,
      envelope as Bytes32,
      bytesToHex(sig)
    );
    expect(sdk).toBe(false);
    expect(chain).toBe(sdk);
  });

  it('keyed verify: after register, delegate sig verifies and owner sig does not', async () => {
    const ownerAddr = deriveAddress(OWNER_KEY);
    const delegateAddr = deriveAddress(DELEGATE_KEY);

    // Produce PoP (delegate signs registry-scoped envelope for owner) and
    // register under the owner's account.
    const popInner = computeEcdsaPopMessage({
      owner: ownerAddr,
      chainId,
      registry: registryAddress,
    });
    const popSigned = wrapPersonalSign(popInner);
    const popSig = signRaw(DELEGATE_KEY, popSigned);

    const ownerAccount = privateKeyToAccount(OWNER_KEY);
    const ownerWallet = createWalletClient({
      chain: foundry,
      transport: http(ANVIL_RPC),
      account: ownerAccount,
    });
    await ownerWallet.writeContract({
      address: registryAddress as `0x${string}`,
      abi: ECDSA_REGISTRY_ABI,
      functionName: 'register',
      args: [delegateAddr as `0x${string}`, bytesToHex(popSig)],
    });

    // Now run the matrix.
    const raw = keccak256(Buffer.from('keyed-matrix')) as HexBytes;
    const envelope = wrapPersonalSign(raw);
    const delegateSig = signRaw(DELEGATE_KEY, envelope);
    const ownerSig = signRaw(OWNER_KEY, envelope);

    const sdkDelegate = verifyEcdsaLocal({
      owner: ownerAddr,
      hash: envelope,
      signature: delegateSig,
      delegate: delegateAddr,
    });
    const chainDelegate = await client.verifyEcdsaWithRegisteredKey(
      registryAddress,
      ownerAddr,
      envelope as Bytes32,
      bytesToHex(delegateSig)
    );
    expect(sdkDelegate).toBe(true);
    expect(chainDelegate).toBe(true);

    const sdkOwner = verifyEcdsaLocal({
      owner: ownerAddr,
      hash: envelope,
      signature: ownerSig,
      delegate: delegateAddr,
    });
    const chainOwner = await client.verifyEcdsaWithRegisteredKey(
      registryAddress,
      ownerAddr,
      envelope as Bytes32,
      bytesToHex(ownerSig)
    );
    expect(sdkOwner).toBe(false);
    expect(chainOwner).toBe(false);
  });

  it('hasDelegate toggles across register → rotate', async () => {
    // Uses state from the previous test: OWNER registered DELEGATE.
    const ownerAddr = deriveAddress(OWNER_KEY);
    const delegateAddr = deriveAddress(DELEGATE_KEY);
    expect(await client.hasEcdsaDelegate(registryAddress, ownerAddr)).toBe(true);

    // Rotate to a fresh delegate (account #3).
    const FRESH_KEY =
      '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6' as const;
    const freshAddr = deriveAddress(FRESH_KEY);
    const popInner = computeEcdsaPopMessage({
      owner: ownerAddr,
      chainId,
      registry: registryAddress,
    });
    const popSigned = wrapPersonalSign(popInner);
    const popSig = signRaw(FRESH_KEY, popSigned);

    const ownerAccount = privateKeyToAccount(OWNER_KEY);
    const ownerWallet = createWalletClient({
      chain: foundry,
      transport: http(ANVIL_RPC),
      account: ownerAccount,
    });
    const hash = await ownerWallet.writeContract({
      address: registryAddress as `0x${string}`,
      abi: ECDSA_REGISTRY_ABI,
      functionName: 'rotate',
      args: [freshAddr as `0x${string}`, bytesToHex(popSig)],
    });
    await client.publicClient.waitForTransactionReceipt({ hash });

    // Post-rotation: delegate still bound (canonical signal), but it's the new one.
    expect(await client.hasEcdsaDelegate(registryAddress, ownerAddr)).toBe(true);

    // Sanity: old-delegate sig no longer verifies.
    const raw = keccak256(Buffer.from('post-rotation')) as HexBytes;
    const envelope = wrapPersonalSign(raw);
    const oldSig = signRaw(DELEGATE_KEY, envelope);
    const newSig = signRaw(FRESH_KEY, envelope);

    const chainOld = await client.verifyEcdsaWithRegisteredKey(
      registryAddress,
      ownerAddr,
      envelope as Bytes32,
      bytesToHex(oldSig)
    );
    const chainNew = await client.verifyEcdsaWithRegisteredKey(
      registryAddress,
      ownerAddr,
      envelope as Bytes32,
      bytesToHex(newSig)
    );
    expect(chainOld).toBe(false);
    expect(chainNew).toBe(true);

    const sdkOld = verifyEcdsaLocal({
      owner: ownerAddr,
      hash: envelope,
      signature: oldSig,
      delegate: freshAddr,
    });
    const sdkNew = verifyEcdsaLocal({
      owner: ownerAddr,
      hash: envelope,
      signature: newSig,
      delegate: freshAddr,
    });
    expect(sdkOld).toBe(false);
    expect(sdkNew).toBe(true);
  });

  it('PoP inner hash matches between SDK and contract', async () => {
    const ownerAddr = deriveAddress(OWNER_KEY);
    // Recompute on-chain via abi.encode and compare to SDK helper.
    const onchain = keccak256(
      encodeAbiParameters(parseAbiParameters('string, uint256, address, address'), [
        'ERC-BAM-ECDSA-PoP.v1',
        BigInt(chainId),
        registryAddress as `0x${string}`,
        ownerAddr as `0x${string}`,
      ])
    );
    const sdk = computeEcdsaPopMessage({
      owner: ownerAddr,
      chainId,
      registry: registryAddress,
    });
    expect(sdk).toBe(onchain);
  });
});
