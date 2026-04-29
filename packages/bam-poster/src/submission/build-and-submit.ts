import { createRequire } from 'node:module';

import {
  commitToBlob,
  createBlob,
  encodeBatch,
  loadTrustedSetup,
  type Address,
  type BAMMessage,
  type Bytes32,
} from 'bam-sdk';
import { BAM_CORE_ABI } from 'bam-sdk';
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  parseGwei,
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
  /**
   * Optional logger for submission-path errors. Default is a no-op —
   * the CLI wires through the same logger it passes to the factory
   * so library consumers can silence/redirect.
   */
  logger?: import('../types.js').PosterLogger;
}

/**
 * Narrow transport surface the submitter needs. Extracted so tests
 * can inject mocks without spinning up a real RPC.
 */
export interface BuildAndSubmitTransport {
  sendBlobTransaction(args: {
    to: Address;
    data: `0x${string}`;
    blobs: readonly Uint8Array[];
    maxFeePerBlobGas: bigint;
    kzg: Kzg;
  }): Promise<`0x${string}`>;
  waitForReceipt(hash: `0x${string}`): Promise<{ blockNumber: bigint; transactionIndex: number }>;
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
 * Heuristic: a thrown message matching one of the patterns below is a
 * structural problem (ABI mismatch, contract revert, malformed tx) —
 * retrying won't help. Everything else (RPC down, gas too high,
 * transient nonce conflict) is retryable.
 *
 * The patterns were deliberately narrowed after a review flagged that
 * a bare /invalid/i also matches common transient errors like
 * "invalid nonce" (node hasn't caught up) or "invalid JSON-RPC
 * response" (network blip). Prefer false-retryable (we pay one more
 * round-trip) over false-permanent (we halt the worker forever).
 */
const PERMANENT_ERROR_PATTERNS: readonly RegExp[] = [
  /execution reverted/i,
  /invalid opcode/i,
  /invalid signature/i,
  /abi\b/i,
  /contract does not exist/i,
  /out of gas/i,
];

export function classifySubmissionError(err: unknown): SubmitOutcome {
  const msg = err instanceof Error ? err.message : String(err);
  for (const pattern of PERMANENT_ERROR_PATTERNS) {
    if (pattern.test(msg)) {
      return { kind: 'permanent', detail: 'submission_failed' };
    }
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
  const decoder = (opts.decoderAddress ?? zeroAddress);
  const sigRegistry = (opts.signatureRegistryAddress ?? zeroAddress);
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
      // Load the KZG trusted setup before `commitToBlob` — the default
      // loader in `ensureKzg` calls bam-sdk's `loadTrustedSetup()`,
      // which primes the native c-kzg state that `commitToBlob` then
      // reads. Without this running first, `commitToBlob` throws
      // "KZG trusted setup not loaded. Call loadTrustedSetup() first."
      const kzg = await ensureKzg();

      const bamMsgs: BAMMessage[] = messages.map((m) => ({
        sender: m.sender,
        nonce: m.nonce,
        contents: m.contents,
      }));
      const signatures = messages.map((m) => m.signature);
      const batch = encodeBatch(bamMsgs, signatures);
      const blob = createBlob(batch.data);
      const { versionedHash } = commitToBlob(blob);
      const data = encodeFunctionData({
        abi: BAM_CORE_ABI,
        functionName: 'registerBlobBatch',
        args: [0n, 0, 4096, contentTag, decoder, sigRegistry],
      });

      // Send the EXACT blob we committed to. bam-sdk's `createBlob`
      // and viem's `toBlobs` pack bytes into field elements
      // differently (viem adds a terminator byte; the SDK leaves
      // trailing FEs zero). If we let viem re-encode, the on-chain
      // versioned hash wouldn't match the `versionedHash` we stored
      // and returned to callers. Pass the SDK-encoded blob directly.
      const txHash = (await transport.sendBlobTransaction({
        to: opts.bamCoreAddress,
        data,
        blobs: [blob],
        maxFeePerBlobGas: parseGwei(gwei),
        kzg,
      }));
      const receipt = await transport.waitForReceipt(txHash);

      return {
        kind: 'included',
        txHash,
        blobVersionedHash: versionedHash,
        blockNumber: Number(receipt.blockNumber),
        txIndex: receipt.transactionIndex,
        submitter: opts.signer.account().address as Address,
      };
    } catch (err) {
      // Log the underlying error before classification — the classifier
      // throws away the message, and without this the health surface
      // reports "tag has failed N times" with no way to see why.
      const detail =
        err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      const log = opts.logger ?? ((_level, msg) => process.stderr.write(`[bam-poster] ${msg}\n`));
      log('error', `submission failed for tag ${contentTag}: ${detail}`);
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
      const r = await publicClient.waitForTransactionReceipt({ hash });
      return { blockNumber: r.blockNumber, transactionIndex: r.transactionIndex };
    },
    async getChainId() {
      return publicClient.getChainId();
    },
    async getBytecode(address) {
      const code = (await publicClient.getBytecode({ address })) ?? '0x';
      return code;
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
