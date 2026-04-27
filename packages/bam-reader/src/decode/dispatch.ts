/**
 * Decode dispatch — turn `usableBytes` into messages + per-message
 * signature bytes.
 *
 * `decoderAddress == 0x0…0` is the canonical-default convention: use
 * the SDK's `decodeBatch` (pure JS, returns immediately). Non-zero
 * `decoderAddress` is dispatched to the on-chain `IERC_BAM_Decoder.decode`
 * via a bounded `eth_call` (gas cap + wallclock timeout). Bounds are
 * red-team C-10's per-batch protection.
 *
 * Structural decode failures (truncated payload, version mismatch, etc.)
 * propagate as `RangeError` from the SDK; the caller treats them as
 * batch-level skips. Dispatch failures (timeout, gas cap, revert) are
 * surfaced as `DecodeDispatchFailed`.
 */

import { decodeBatch } from 'bam-sdk';
import type { Address, BAMMessage } from 'bam-sdk';

import { DecodeDispatchFailed } from '../errors.js';
import {
  callOnChainDecoder,
  type ReadContractClient,
} from './on-chain-decoder.js';
import { assertZstdWithinBound, type ZstdBoundOptions } from './zstd-bound.js';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;

export type { ReadContractClient } from './on-chain-decoder.js';

export interface DecodeOptions {
  decoderAddress: Address;
  usableBytes: Uint8Array;
  publicClient?: ReadContractClient;
  gasCap: bigint;
  timeoutMs: number;
  /**
   * ZSTD decompression bound override. Default caps decompressed size
   * at 2× `usableBytes.length`; raise the multiplier only with a
   * specific reason (red-team C-4).
   */
  zstdBound?: ZstdBoundOptions;
}

export interface DecodeResult {
  messages: BAMMessage[];
  signatures: Uint8Array[];
}

function isZeroAddress(addr: Address): boolean {
  return addr.toLowerCase() === ZERO_ADDRESS;
}

/**
 * Decode `usableBytes` into messages + per-message signatures. The
 * canonical-default `0x0…0` decoder address shortcuts to the SDK's
 * pure-JS `decodeBatch`; any other address is dispatched on-chain.
 */
export async function decode(opts: DecodeOptions): Promise<DecodeResult> {
  if (isZeroAddress(opts.decoderAddress)) {
    // Pre-check the ZSTD-frame size header before letting the SDK
    // allocate the decompressed buffer (red-team C-4).
    assertZstdWithinBound(opts.usableBytes, opts.zstdBound);
    // Pure JS — propagates structural errors as RangeError; do not
    // wrap, so the caller can distinguish structural failure from
    // dispatch failure.
    return decodeBatch(opts.usableBytes);
  }

  if (!opts.publicClient) {
    throw new DecodeDispatchFailed(
      `non-zero decoder ${opts.decoderAddress} requires a publicClient`
    );
  }

  return callOnChainDecoder({
    decoderAddress: opts.decoderAddress,
    usableBytes: opts.usableBytes,
    publicClient: opts.publicClient,
    gasCap: opts.gasCap,
    timeoutMs: opts.timeoutMs,
  });
}
