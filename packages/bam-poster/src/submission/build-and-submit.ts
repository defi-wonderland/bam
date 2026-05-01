import { createRequire } from 'node:module';

import {
  assembleMultiSegmentBlob,
  commitToBlob,
  loadTrustedSetup,
  type Address,
  type Bytes32,
} from 'bam-sdk';
import { BAM_CORE_ABI } from 'bam-sdk';
import { validatePackPlanInvariants } from './pack.js';
import { verifyPackedBlobRoundTrips, PackSelfCheckMismatch } from './self-check.js';
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
import type {
  BuildAndSubmitMulti,
  PackedSubmitIncludedEntry,
} from './types.js';

export interface BuildAndSubmitOptions {
  rpcUrl: string;
  chainId: number;
  bamCoreAddress: Address;
  signer: Signer;
  /**
   * Per-segment decoder. The packed flow passes this verbatim into
   * every entry of the `registerBlobBatches` array; pick the address
   * appropriate for the wire format the aggregator is encoding (zero
   * for the binary codec, the registry-resolved `ABIDecoder` for the
   * v1 ABI shape from #39). The CLI always sets this; the field is
   * optional purely so unit tests don't have to thread `zeroAddress`
   * through every fixture — the runtime falls back to `zeroAddress`.
   */
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
  /** Multi-tag (packed) submission. Calls `registerBlobBatches`. */
  buildAndSubmitMulti: BuildAndSubmitMulti;
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

export function classifySubmissionError(
  err: unknown
):
  | { kind: 'retryable'; detail: string }
  | { kind: 'permanent'; detail: string } {
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
 * via `registerBlobBatches` on the BAM Core contract, and to reconcile
 * chain-id + contract bytecode at startup.
 *
 * KZG trusted-setup loading happens lazily on the first submission so
 * CLI startup stays fast even when the Poster hasn't yet been asked to
 * submit a batch.
 */
export async function buildAndSubmitWithViem(
  opts: BuildAndSubmitOptions
): Promise<BuildAndSubmitBundle> {
  const decoder = opts.decoderAddress ?? zeroAddress;
  const sigRegistry = opts.signatureRegistryAddress ?? zeroAddress;
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

  const buildAndSubmitMulti: BuildAndSubmitMulti = async ({ pack }) => {
    if (pack.plan.included.length === 0) {
      return { kind: 'permanent', detail: 'empty_pack' };
    }
    const log =
      opts.logger ?? ((_level, msg) => process.stderr.write(`[bam-poster] ${msg}\n`));

    // Pre-broadcast: every failure here is a producer-side bug
    // (plan-invariant violation, FE-alignment mismatch, content
    // round-trip mismatch). Treat as permanent so the aggregator halts
    // for operator inspection rather than retrying a known-bad plan.
    let blob: Uint8Array;
    let versionedHash: Bytes32;
    let data: `0x${string}`;
    let kzg: Kzg;
    try {
      kzg = await ensureKzg();

      // 1. Validate the plan's structural invariants (overlap, OOB,
      //    inverted ranges). Aggregator-level bug → permanent failure.
      validatePackPlanInvariants(pack.plan);

      // 2. Assemble the multi-segment blob from the plan's payload bytes.
      const segments = pack.plan.included.map((seg) => ({
        contentTag: seg.contentTag,
        payload: seg.payloadBytes,
      }));
      const assembledOut = assembleMultiSegmentBlob(segments);
      blob = assembledOut.blob;
      const assembled = assembledOut.segments;

      // Defense in depth: the aggregator's plan and the SDK's
      // FE-alignment math are computed independently. They MUST agree.
      for (let i = 0; i < pack.plan.included.length; i++) {
        const planEntry = pack.plan.included[i]!;
        const asm = assembled[i]!;
        if (planEntry.startFE !== asm.startFE || planEntry.endFE !== asm.endFE) {
          throw new PackSelfCheckMismatch(
            planEntry.contentTag,
            `plan-vs-assembly-mismatch:plan=(${planEntry.startFE},${planEntry.endFE}) ` +
              `asm=(${asm.startFE},${asm.endFE})`
          );
        }
      }

      // 3. Producer-side runtime self-check (T020): decode every per-tag
      //    slice through the same SDK path the Reader will use; refuse
      //    to broadcast on any mismatch.
      verifyPackedBlobRoundTrips(blob, pack.plan, pack.includedSelections);

      // 4. Compute the versioned hash for the assembled blob.
      versionedHash = commitToBlob(blob).versionedHash;

      // 5. Encode the call: registerBlobBatches([{...}, ...]). All
      //    entries reference blobIndex=0 (the single blob in this tx).
      const calls = pack.plan.included.map((seg) => ({
        blobIndex: 0n,
        startFE: seg.startFE,
        endFE: seg.endFE,
        contentTag: seg.contentTag,
        decoder,
        signatureRegistry: sigRegistry,
      }));
      data = encodeFunctionData({
        abi: BAM_CORE_ABI,
        functionName: 'registerBlobBatches',
        args: [calls],
      });
    } catch (err) {
      const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      if (err instanceof PackSelfCheckMismatch) {
        log(
          'error',
          `pack self-check mismatch (PERMANENT) tag=${err.contentTag} reason=${err.reason}`
        );
        return { kind: 'permanent', detail: `self_check:${err.reason}` };
      }
      log('error', `pre-broadcast plan validation failed (PERMANENT): ${detail}`);
      return { kind: 'permanent', detail: `pre_broadcast:${detail}` };
    }

    // Broadcast: errors here are typically RPC-side and follow the
    // existing retryable/permanent classifier shared with the
    // single-tag path.
    try {
      const txHash = await transport.sendBlobTransaction({
        to: opts.bamCoreAddress,
        data,
        blobs: [blob],
        maxFeePerBlobGas: parseGwei(gwei),
        kzg,
      });
      const receipt = await transport.waitForReceipt(txHash);

      const entries: PackedSubmitIncludedEntry[] = pack.plan.included.map((seg) => {
        const selection = pack.includedSelections.get(seg.contentTag)!;
        return {
          contentTag: seg.contentTag,
          startFE: seg.startFE,
          endFE: seg.endFE,
          messages: selection.messages,
        };
      });

      return {
        kind: 'included',
        txHash,
        blockNumber: Number(receipt.blockNumber),
        txIndex: receipt.transactionIndex,
        blobVersionedHash: versionedHash,
        submitter: opts.signer.account().address as Address,
        entries,
      };
    } catch (err) {
      const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      log('error', `packed submission broadcast failed: ${detail}`);
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

  return { buildAndSubmitMulti, rpc };
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
