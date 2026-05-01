/**
 * Builds the EIP-712 typed-data payload that the demo's widget
 * passes to `window.ethereum.request({ method: 'eth_signTypedData_v4' })`.
 *
 * The shape is identical to what `bam-sdk`'s `computeECDSADigest`
 * consumes (and what `bam-twitter`'s wagmi-driven path produces),
 * with one addition: a raw `eth_signTypedData_v4` request must
 * carry `EIP712Domain` in `types` because viem (which `bam-sdk`
 * and wagmi use) derives it from the domain object on the
 * caller's behalf — that derivation isn't done by the wallet.
 *
 * The shared `EIP712_DOMAIN_NAME`, `EIP712_DOMAIN_VERSION`, and
 * `EIP712_TYPES` constants are re-exported from `bam-sdk/browser`
 * so any change to the SDK domain or types propagates to the
 * widget by recompilation rather than by hand-edit.
 *
 * Parity is enforced by `test/typed-data-parity.test.ts`: hashing
 * the widget's typed-data with viem's `hashTypedData` must
 * produce the same digest as `computeECDSADigest`.
 */

import {
  EIP712_DOMAIN_NAME,
  EIP712_DOMAIN_VERSION,
  EIP712_TYPES,
} from 'bam-sdk/browser';
import type { Hex } from 'viem';

/**
 * Wire shape `eth_signTypedData_v4` accepts as `params[1]` after
 * `JSON.stringify`. `nonce` is a string because uint64 exceeds JS
 * `Number.MAX_SAFE_INTEGER` and the JSON-RPC layer can't carry a
 * `bigint` directly.
 */
export interface BAMMessageTypedData {
  domain: {
    name: typeof EIP712_DOMAIN_NAME;
    version: typeof EIP712_DOMAIN_VERSION;
    chainId: number;
  };
  types: {
    EIP712Domain: ReadonlyArray<{ name: string; type: string }>;
    BAMMessage: typeof EIP712_TYPES.BAMMessage;
  };
  primaryType: 'BAMMessage';
  message: {
    sender: Hex;
    nonce: string;
    contents: Hex;
  };
}

const EIP712_DOMAIN_TYPE = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
] as const;

export function buildBamTypedData(args: {
  sender: Hex;
  nonce: bigint;
  contents: Hex;
  chainId: number;
}): BAMMessageTypedData {
  return {
    domain: {
      name: EIP712_DOMAIN_NAME,
      version: EIP712_DOMAIN_VERSION,
      chainId: args.chainId,
    },
    types: {
      EIP712Domain: EIP712_DOMAIN_TYPE,
      BAMMessage: EIP712_TYPES.BAMMessage,
    },
    primaryType: 'BAMMessage',
    message: {
      sender: args.sender,
      nonce: args.nonce.toString(),
      contents: args.contents,
    },
  };
}
