/**
 * Per-message verify dispatch.
 *
 * `registryAddress == 0x0…0` is the canonical-default convention: use
 * the SDK's pure-JS `verifyECDSA` (synchronous, EIP-712-bound to
 * `chainId`). Non-zero `registryAddress` is dispatched on-chain to
 * `IERC_BAM_SignatureRegistry.verifyWithRegisteredKey` via a bounded
 * `eth_call`. Bounds (gas cap + wallclock timeout) and every error
 * path resolve to `false` per red-team C-10 — never a halt and never
 * an unsigned write.
 *
 * The MVP non-zero path treats the registry as ECDSA-shaped (passes
 * the EIP-712 digest as the registry's `messageHash` argument). BLS /
 * other-scheme registries are out of scope until the canonical-address
 * fast-path lands (deferred per `plan.md` §Risks deferred).
 */

import type { Address, BAMMessage, Bytes32 } from 'bam-sdk';
import { bytesToHex, computeECDSADigest, verifyECDSA } from 'bam-sdk';

import {
  callOnChainVerify,
  type OnChainVerifyEvent,
  type VerifyReadContractClient,
} from './on-chain-registry.js';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;

export type { OnChainVerifyEvent, VerifyReadContractClient } from './on-chain-registry.js';

export interface VerifyMessageOptions {
  registryAddress: Address;
  message: BAMMessage;
  signatureBytes: Uint8Array;
  chainId: number;
  publicClient?: VerifyReadContractClient;
  gasCap: bigint;
  timeoutMs: number;
  logger?: (event: OnChainVerifyEvent) => void;
}

function isZeroAddress(addr: Address): boolean {
  return addr.toLowerCase() === ZERO_ADDRESS;
}

/**
 * Verify a single message's signature. Returns `true` on a valid
 * signature; `false` on every other path (invalid signature, wrong
 * length, registry revert, timeout, gas-cap exceeded, etc.). On
 * non-zero-registry failures, calls `logger` with a structured event
 * before returning `false`.
 */
export async function verifyMessage(opts: VerifyMessageOptions): Promise<boolean> {
  const sigHex = bytesToHex(opts.signatureBytes) as `0x${string}`;

  if (isZeroAddress(opts.registryAddress)) {
    return verifyECDSA(opts.message, sigHex, opts.message.sender, opts.chainId);
  }

  if (!opts.publicClient) {
    // No public client wired; treat as skip + log so the loop continues.
    opts.logger?.({
      kind: 'verify_skipped',
      registryAddress: opts.registryAddress,
      cause: 'revert',
      detail: 'non-zero registry without publicClient',
    });
    return false;
  }

  const messageHash = computeECDSADigest(opts.message, opts.chainId) as Bytes32;
  return callOnChainVerify({
    registryAddress: opts.registryAddress,
    owner: opts.message.sender,
    messageHash,
    signatureHex: sigHex,
    publicClient: opts.publicClient,
    gasCap: opts.gasCap,
    timeoutMs: opts.timeoutMs,
    logger: opts.logger,
  });
}
