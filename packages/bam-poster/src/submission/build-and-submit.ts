import { createRequire } from 'node:module';

import {
  commitToBlob,
  createBlob,
  encodeBatch,
  loadTrustedSetup,
  type Address,
  type Bytes32,
  type SignedMessage,
} from 'bam-sdk';
import { BAM_CORE_ABI } from 'bam-sdk';
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  parseGwei,
  toBlobs,
  zeroAddress,
  type Kzg,
  type PublicClient,
} from 'viem';

// `c-kzg` ships CJS. ESM modules don't have `require` in scope; use
// createRequire against this module's URL so the resolution happens
// against our own dependency tree. Without this, the default kzgLoader
// would throw `ReferenceError: require is not defined` on first real
// submission.
const requireCjs = createRequire(import.meta.url);

import type { BlockSource } from './reorg-watcher.js';
import type { ReconcileRpcClient } from '../startup/reconcile.js';
import type { Signer } from '../types.js';
import type { StatusRpcReader } from '../surfaces/status.js';
import type { BuildAndSubmit, SubmitOutcome } from './types.js';

export interface BuildAndSubmitOptions {
  rpcUrl: string;
  chainId: number;
  bamCoreAddress: Address;
  signer: Signer;
  decoderAddress?: Address;
  signatureRegistryAddress?: Address;
  maxFeePerBlobGasGwei?: string;
  /** Test injection: override the transport adapter (default uses viem). */
  transport?: BuildAndSubmitTransport;
  /** Test injection: override the KZG loader (default uses `c-kzg`). */
  kzgLoader?: () => Promise<Kzg>;
}

/**
 * Narrow transport surface the submitter needs. Extracted so tests
 * can inject mocks without spinning up a real RPC (FU-9).
 */
export interface BuildAndSubmitTransport {
  sendBlobTransaction(args: {
    to: Address;
    data: `0x${string}`;
    blobs: readonly Uint8Array[];
    maxFeePerBlobGas: bigint;
    kzg: Kzg;
  }): Promise<`0x${string}`>;
  waitForReceipt(hash: `0x${string}`): Promise<{ blockNumber: bigint }>;
  getChainId(): Promise<number>;
  getBytecode(address: Address): Promise<`0x${string}`>;
  getBalance(address: Address): Promise<bigint>;
  getBlockNumber(): Promise<bigint>;
  getTransactionReceipt(hash: Bytes32): Promise<{ blockNumber: bigint } | null>;
}

export interface BuildAndSubmitBundle {
  buildAndSubmit: BuildAndSubmit;
  rpc: ReconcileRpcClient & StatusRpcReader & BlockSource;
}

/**
 * Exported so tests + future operators can call it directly when
 * classifying an arbitrary error without going through the full
 * submission flow.
 *
 * Heuristic: a thrown message matching /revert/i or /invalid/i is a
 * structural problem (ABI mismatch, contract revert, malformed tx) —
 * retrying won't help. Everything else (RPC down, gas too high,
 * transient nonce conflict) is retryable.
 */
export function classifySubmissionError(err: unknown): SubmitOutcome {
  const msg = err instanceof Error ? err.message : String(err);
  if (/revert/i.test(msg) || /invalid/i.test(msg)) {
    return { kind: 'permanent', detail: 'submission_failed' };
  }
  return { kind: 'retryable', detail: 'submission_failed' };
}

/**
 * Real on-chain submitter + RPC reader bundle. Produces the Node-only
 * pieces the factory needs to submit a blob-carrying type-3 transaction
 * via `registerBlobBatch` on the BAM Core contract, and to reconcile
 * chain-id + contract bytecode at startup.
 *
 * KZG trusted-setup loading happens lazily on the first submission so
 * CLI startup stays fast even when the Poster hasn't yet been asked to
 * submit a batch.
 */
export async function buildAndSubmitWithViem(
  opts: BuildAndSubmitOptions
): Promise<BuildAndSubmitBundle> {
  const decoder = (opts.decoderAddress ?? zeroAddress) as Address;
  const sigRegistry = (opts.signatureRegistryAddress ?? zeroAddress) as Address;
  const gwei = opts.maxFeePerBlobGasGwei ?? '30';

  const transport = opts.transport ?? viemTransport(opts);

  let kzgLoaded = false;
  let kzgForViem: Kzg | null = null;
  const ensureKzg = opts.kzgLoader ?? (async (): Promise<Kzg> => {
    if (!kzgLoaded) {
      loadTrustedSetup();
      kzgLoaded = true;
    }
    if (kzgForViem === null) {
      const cKzg = requireCjs('c-kzg') as {
        blobToKzgCommitment: Kzg['blobToKzgCommitment'];
        computeBlobKzgProof: Kzg['computeBlobKzgProof'];
      };
      kzgForViem = {
        blobToKzgCommitment: cKzg.blobToKzgCommitment,
        computeBlobKzgProof: cKzg.computeBlobKzgProof,
      };
    }
    return kzgForViem;
  });

  const buildAndSubmit: BuildAndSubmit = async ({ contentTag, messages }) => {
    try {
      const signed: SignedMessage[] = messages.map((m) => ({
        author: m.author,
        timestamp: m.timestamp,
        nonce: Number(m.nonce & 0xffffn),
        content: m.content,
        signature: m.signature,
        signatureType: 'ecdsa',
      }));
      const batch = encodeBatch(signed);
      const blob = createBlob(batch.data);
      const { versionedHash } = commitToBlob(blob);

      const kzg = await ensureKzg();
      const data = encodeFunctionData({
        abi: BAM_CORE_ABI,
        functionName: 'registerBlobBatch',
        args: [0n, 0, 4096, contentTag, decoder, sigRegistry],
      });

      const txHash = (await transport.sendBlobTransaction({
        to: opts.bamCoreAddress,
        data,
        blobs: toBlobs({ data: batch.data }),
        maxFeePerBlobGas: parseGwei(gwei),
        kzg,
      })) as Bytes32;
      const receipt = await transport.waitForReceipt(txHash);

      return {
        kind: 'included',
        txHash,
        blobVersionedHash: versionedHash,
        blockNumber: Number(receipt.blockNumber),
      };
    } catch (err) {
      return classifySubmissionError(err);
    }
  };

  const rpc: ReconcileRpcClient & StatusRpcReader & BlockSource = {
    async getChainId(): Promise<number> {
      return transport.getChainId();
    },
    async getCode(address: Address): Promise<`0x${string}`> {
      return transport.getBytecode(address);
    },
    async getBalance(address: Address): Promise<bigint> {
      return transport.getBalance(address);
    },
    async getBlockNumber(): Promise<bigint> {
      return transport.getBlockNumber();
    },
    async getTransactionBlock(txHash: Bytes32): Promise<number | null> {
      const receipt = await transport.getTransactionReceipt(txHash);
      return receipt ? Number(receipt.blockNumber) : null;
    },
  };

  return { buildAndSubmit, rpc };
}

function viemTransport(opts: BuildAndSubmitOptions): BuildAndSubmitTransport {
  const publicClient: PublicClient = createPublicClient({
    chain: undefined,
    transport: http(opts.rpcUrl),
  });
  const walletClient = createWalletClient({
    account: opts.signer.account(),
    chain: undefined,
    transport: http(opts.rpcUrl),
  });
  return {
    async sendBlobTransaction({ to, data, blobs, maxFeePerBlobGas, kzg }) {
      return walletClient.sendTransaction({
        to,
        data,
        blobs: [...blobs],
        maxFeePerBlobGas,
        kzg,
        chain: null,
      });
    },
    async waitForReceipt(hash) {
      return publicClient.waitForTransactionReceipt({ hash });
    },
    async getChainId() {
      return publicClient.getChainId();
    },
    async getBytecode(address) {
      const code = (await publicClient.getBytecode({ address })) ?? '0x';
      return code as `0x${string}`;
    },
    async getBalance(address) {
      return publicClient.getBalance({ address });
    },
    async getBlockNumber() {
      return publicClient.getBlockNumber();
    },
    async getTransactionReceipt(hash) {
      try {
        const r = await publicClient.getTransactionReceipt({ hash });
        return { blockNumber: r.blockNumber };
      } catch {
        return null;
      }
    },
  };
}
