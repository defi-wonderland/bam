/**
 * EIP-712 domain + typed-data helpers for BAM scheme 0x01.
 *
 * Pulled out of `signatures.ts` so a browser-only consumer can import
 * the EIP-712 surface without dragging in `@noble/bls12-381` /
 * `@noble/secp256k1`. With `"sideEffects": false` on the package, a
 * tree-shaking bundler that only imports `EIP712_TYPES` /
 * `computeECDSADigest` from `bam-sdk/browser` ends up shipping just
 * the viem `hashTypedData` call plus this file's constants.
 *
 * @module bam-sdk/eip712
 */

import { hashTypedData } from 'viem';

import type { BAMMessage, Bytes32 } from './types.js';
import { bytesToHex } from './message.js';

export const EIP712_DOMAIN_NAME = 'BAM';
export const EIP712_DOMAIN_VERSION = '1';

/**
 * EIP-712 typed-data schema for a BAM message.
 *
 * Field order mirrors the `messageHash` preimage:
 * `sender, contentTag, nonce, contents`. `contentTag` is bound here
 * so the digest a scheme-0x01 signer signs is tied to a specific app;
 * an aggregator that places the signed envelope into a segment with a
 * different `contentTag` produces a digest that does not match.
 */
export const EIP712_TYPES = {
  BAMMessage: [
    { name: 'sender', type: 'address' },
    { name: 'contentTag', type: 'bytes32' },
    { name: 'nonce', type: 'uint64' },
    { name: 'contents', type: 'bytes' },
  ],
} as const;

/**
 * Compute the EIP-712 digest a scheme-0x01 signer signs.
 *
 * Chain-bound by construction: the same message on a different
 * `chainId` yields a different digest, so cross-chain signature replay
 * is not reachable. Tag-bound: the same `(sender, nonce, contents)`
 * under a different `contentTag` yields a different digest, so the
 * cross-app re-routing that the BLS path's `messageHash` formula
 * prevents is closed for ECDSA too.
 *
 * `contentTag` is supplied separately because it is a property of the
 * batch the message lands in (read from the registration event), not
 * of the message itself.
 */
export function computeECDSADigest(
  message: BAMMessage,
  contentTag: Bytes32,
  chainId: number
): Bytes32 {
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
      contentTag,
      nonce: message.nonce,
      contents: bytesToHex(message.contents) as `0x${string}`,
    },
  });
}
