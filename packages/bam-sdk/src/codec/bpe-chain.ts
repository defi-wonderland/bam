/**
 * Load a BPE dictionary from an on-chain `BPEDictionary` contract.
 *
 * The on-chain dictionary stores its 10240-byte table inside a code-only data
 * contract (SSTORE2 pattern) whose first runtime byte is `STOP` (0x00) and
 * whose remaining 10240 bytes are the dictionary itself. This module:
 *
 *   1. Reads `BPEDictionary.DICT_DATA()` and `BPEDictionary.IDENTITY()`.
 *   2. Fetches the data contract's bytecode via `eth_getCode`.
 *   3. Strips the leading STOP and takes the next 10240 bytes.
 *   4. Verifies `keccak256(bytes) === IDENTITY` (unless `verifyIdentity: false`).
 *   5. Returns a `BPEDictionary` JS object ready for `encodeBatchBPE` / `bpeDecode`.
 *
 * @module bam-sdk/codec/bpe-chain
 */

import { keccak256, type Address, type PublicClient } from 'viem';
import { bpeDictionaryFromBytes, type BPEDictionary } from '../bpe.js';
import { hexToBytes } from '../message.js';

const DICT_SIZE = 10_240;

const BPE_DICTIONARY_ABI = [
  {
    type: 'function',
    name: 'DICT_DATA',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'IDENTITY',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bytes32' }],
  },
] as const;

export interface LoadBPEDictionaryOptions {
  /**
   * If true (default), throws when `keccak256(dictBytes) !== IDENTITY()`.
   * Set false only if you have a reason to accept divergence (e.g. you've already
   * fetched the bytes some other way and just want to bypass the re-check).
   */
  verifyIdentity?: boolean;
}

export interface OnChainBPEDictionary extends BPEDictionary {
  /** Address of the BPEDictionary contract this was loaded from. */
  contractAddress: Address;
  /** Address of the SSTORE2 data contract holding the raw dict bytes. */
  dictDataAddress: Address;
  /** The contract's published IDENTITY (typically keccak256 of the dict bytes). */
  identity: `0x${string}`;
}

/**
 * Fetch a BPE dictionary from a deployed `BPEDictionary` contract.
 *
 * @example
 * ```ts
 * import { createPublicClient, http } from 'viem';
 * import { sepolia } from 'viem/chains';
 * import { loadBPEDictionaryFromChain } from 'bam-sdk';
 *
 * const client = createPublicClient({ chain: sepolia, transport: http() });
 * const dict = await loadBPEDictionaryFromChain(client, '0xDictAddress');
 * // dict can be passed to encodeBatchBPE / bpeDecode like any other BPEDictionary.
 * ```
 */
export async function loadBPEDictionaryFromChain(
  client: PublicClient,
  address: Address,
  opts: LoadBPEDictionaryOptions = {}
): Promise<OnChainBPEDictionary> {
  const verifyIdentity = opts.verifyIdentity ?? true;

  const [dictDataAddress, identity] = (await Promise.all([
    client.readContract({
      address,
      abi: BPE_DICTIONARY_ABI,
      functionName: 'DICT_DATA',
    }),
    client.readContract({
      address,
      abi: BPE_DICTIONARY_ABI,
      functionName: 'IDENTITY',
    }),
  ])) as [Address, `0x${string}`];

  const code = await client.getBytecode({ address: dictDataAddress });
  if (!code) {
    throw new Error(`No bytecode at DICT_DATA address ${dictDataAddress}`);
  }
  const codeBytes = hexToBytes(code);
  if (codeBytes.length !== DICT_SIZE + 1) {
    throw new Error(
      `Unexpected dict data contract size: ${codeBytes.length} bytes (expected ${DICT_SIZE + 1})`
    );
  }
  if (codeBytes[0] !== 0x00) {
    throw new Error(
      `Dict data contract does not start with STOP (got 0x${codeBytes[0]
        .toString(16)
        .padStart(2, '0')})`
    );
  }
  const dictBytes = codeBytes.subarray(1);

  if (verifyIdentity) {
    const local = keccak256(dictBytes);
    if (local.toLowerCase() !== identity.toLowerCase()) {
      throw new Error(
        `BPEDictionary IDENTITY mismatch: chain reports ${identity}, computed ${local}`
      );
    }
  }

  const base = bpeDictionaryFromBytes(dictBytes);
  return {
    ...base,
    contractAddress: address,
    dictDataAddress,
    identity,
  };
}
