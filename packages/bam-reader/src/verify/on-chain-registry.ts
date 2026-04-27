/**
 * On-chain signature-registry dispatch — bounded `eth_call` to a
 * contract that implements
 * `IERC_BAM_SignatureRegistry.verifyWithRegisteredKey`.
 *
 * Lives in its own module so the dispatch policy (in `dispatch.ts`)
 * stays free of viem plumbing, and so this surface can be unit-tested
 * with a stub `ReadContractClient`.
 *
 * Per red-team C-10, this layer treats every error path as a verify
 * failure (`false`) plus a structured-log entry — never a halt and
 * never a `confirmed` write. Callers (T013's `processBatch`)
 * propagate `false` as a per-message skip.
 */

import type { Address, Bytes32 } from 'bam-sdk';

/**
 * Minimal `verifyWithRegisteredKey` ABI for the dispatch — the SDK's
 * `ECDSA_REGISTRY_ABI` is not re-exported from its top-level entry,
 * and pulling in the rest of the registry surface buys us nothing
 * here.
 */
export const VERIFY_WITH_REGISTERED_KEY_ABI = [
  {
    type: 'function',
    name: 'verifyWithRegisteredKey',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'messageHash', type: 'bytes32' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

export type OnChainVerifyFailure = 'gas_cap' | 'timeout' | 'revert';

export type OnChainVerifyEvent = {
  kind: 'verify_skipped';
  registryAddress: Address;
  cause: OnChainVerifyFailure;
  detail: string;
};

export type OnChainVerifyLogger = (event: OnChainVerifyEvent) => void;

export interface VerifyReadContractClient {
  readContract(args: {
    address: Address;
    abi: typeof VERIFY_WITH_REGISTERED_KEY_ABI;
    functionName: 'verifyWithRegisteredKey';
    args: readonly [Address, Bytes32, `0x${string}`];
    gas?: bigint;
  }): Promise<boolean>;
}

export interface OnChainVerifyOptions {
  registryAddress: Address;
  owner: Address;
  messageHash: Bytes32;
  signatureHex: `0x${string}`;
  publicClient: VerifyReadContractClient;
  gasCap: bigint;
  timeoutMs: number;
  logger?: OnChainVerifyLogger;
}

class OnChainVerifyTimeout extends Error {}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new OnChainVerifyTimeout(`timed out after ${ms}ms`)),
          ms
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function classify(detail: string): OnChainVerifyFailure {
  const lower = detail.toLowerCase();
  if (lower.includes('gas') && (lower.includes('cap') || lower.includes('exceeds'))) {
    return 'gas_cap';
  }
  return 'revert';
}

export async function callOnChainVerify(
  opts: OnChainVerifyOptions
): Promise<boolean> {
  try {
    return await withTimeout(
      opts.publicClient.readContract({
        address: opts.registryAddress,
        abi: VERIFY_WITH_REGISTERED_KEY_ABI,
        functionName: 'verifyWithRegisteredKey',
        args: [opts.owner, opts.messageHash, opts.signatureHex],
        gas: opts.gasCap,
      }),
      opts.timeoutMs
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const cause: OnChainVerifyFailure =
      err instanceof OnChainVerifyTimeout ? 'timeout' : classify(detail);
    opts.logger?.({
      kind: 'verify_skipped',
      registryAddress: opts.registryAddress,
      cause,
      detail,
    });
    return false;
  }
}
