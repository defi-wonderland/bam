/**
 * EIP-712 typed-data assembly for BAM scheme 0x01.
 *
 * The widget builds the typed-data payload itself (rather than
 * delegating to `bam-sdk`'s `signECDSA`) because that function
 * imports the secp256k1 curve at module load — pulling several kB of
 * @noble code into the bundle for no benefit, since wallet signing
 * happens entirely in the browser provider.
 *
 * The shape MUST match `bam-sdk`'s `computeECDSADigest`:
 *
 *   domain   = { name: "BAM", version: "1", chainId }
 *   types    = { BAMMessage: [sender, contentTag, nonce, contents] }
 *   message  = { sender, contentTag, nonce, contents (hex) }
 *
 * `typed-data-parity.test.ts` pins this with several fixtures.
 */

import { hashTypedData } from 'viem';
import {
  EIP712_DOMAIN_NAME,
  EIP712_DOMAIN_VERSION,
  EIP712_TYPES,
} from 'bam-sdk/browser';

import { bytesToHex } from './hex.js';

export interface BamTypedData {
  domain: {
    name: typeof EIP712_DOMAIN_NAME;
    version: typeof EIP712_DOMAIN_VERSION;
    chainId: number;
  };
  types: typeof EIP712_TYPES;
  primaryType: 'BAMMessage';
  message: {
    sender: `0x${string}`;
    contentTag: `0x${string}`;
    nonce: bigint;
    contents: `0x${string}`;
  };
}

export function buildTypedData(args: {
  sender: `0x${string}`;
  contentTag: `0x${string}`;
  nonce: bigint;
  contents: Uint8Array;
  chainId: number;
}): BamTypedData {
  return {
    domain: {
      name: EIP712_DOMAIN_NAME,
      version: EIP712_DOMAIN_VERSION,
      chainId: args.chainId,
    },
    types: EIP712_TYPES,
    primaryType: 'BAMMessage',
    message: {
      sender: args.sender,
      contentTag: args.contentTag,
      nonce: args.nonce,
      contents: bytesToHex(args.contents),
    },
  };
}

/**
 * Test-side helper that recomputes the EIP-712 digest of typed data
 * the widget produced. Re-exports `viem`'s `hashTypedData` against
 * this app's domain so the parity test can compare to
 * `computeECDSADigest`.
 */
export function digestTypedData(td: BamTypedData): `0x${string}` {
  return hashTypedData({
    domain: td.domain,
    types: td.types,
    primaryType: td.primaryType,
    message: {
      ...td.message,
    },
  });
}

/**
 * Serialise the typed-data payload for `eth_signTypedData_v4`. The
 * EIP-1193 method takes a JSON string with bigints encoded as decimal
 * strings (numbers ≥ 2^53 lose precision otherwise). Mirrors what
 * viem does under the hood for `signTypedData`.
 */
export function serializeTypedDataForRpc(td: BamTypedData): string {
  return JSON.stringify({
    domain: td.domain,
    primaryType: td.primaryType,
    types: {
      // EIP712Domain is required by the RPC schema even though
      // `bam-sdk`'s `EIP712_TYPES` omits it (viem fills it in
      // automatically; we have to do it explicitly here).
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
      ],
      ...td.types,
    },
    message: {
      sender: td.message.sender,
      contentTag: td.message.contentTag,
      nonce: td.message.nonce.toString(),
      contents: td.message.contents,
    },
  });
}
