/**
 * EIP-712 typed-data constants and digest computation for BAM
 * scheme-0x01 (ECDSA) signatures.
 *
 * Carved out of `signatures.ts` so consumers that only need the
 * typed-data shape (e.g. browser dApps signing via the wallet's
 * `eth_signTypedData_v4`) can import from here without dragging
 * `@noble/secp256k1` and `@noble/bls12-381` into their bundle.
 *
 * `signatures.ts` re-exports these names so existing imports keep
 * working.
 */

import { hashTypedData } from 'viem';

import type { BAMMessage, Bytes32 } from './types.js';
import { bytesToHex } from './message.js';

/**
 * EIP-712 domain fields BAM uses for scheme 0x01.
 *
 * `chainId` is supplied per call so a single signer can sign for
 * multiple deployments. `verifyingContract` is intentionally absent: a
 * BAM self-publication claim is not a transaction targeted at a specific
 * contract, and embedding one would imply a relationship that doesn't
 * exist at the protocol layer. Some hardware wallets warn on the
 * omission; this is an accepted UX cost documented in the SDK README.
 */
export const EIP712_DOMAIN_NAME = 'BAM';
export const EIP712_DOMAIN_VERSION = '1';

/**
 * EIP-712 typed-data schema for a BAM message.
 */
export const EIP712_TYPES = {
  BAMMessage: [
    { name: 'sender', type: 'address' },
    { name: 'nonce', type: 'uint64' },
    { name: 'contents', type: 'bytes' },
  ],
} as const;

/**
 * Compute the EIP-712 digest a scheme-0x01 signer signs. Chain-bound
 * by construction: the same `BAMMessage` on a different `chainId`
 * yields a different digest, so cross-chain signature replay is not
 * reachable.
 */
export function computeECDSADigest(message: BAMMessage, chainId: number): Bytes32 {
  return hashTypedData({
    domain: {
      name: EIP712_DOMAIN_NAME,
      version: EIP712_DOMAIN_VERSION,
      chainId,
    },
    types: EIP712_TYPES,
    primaryType: 'BAMMessage',
    message: {
      sender: message.sender,
      nonce: message.nonce,
      contents: bytesToHex(message.contents) as `0x${string}`,
    },
  });
}
