/**
 * On-chain decoder dispatch — bounded `eth_call` to a contract that
 * implements `IERC_BAM_Decoder.decode(bytes)`.
 *
 * Lives in its own module so the dispatch policy (in `dispatch.ts`)
 * stays free of viem/eth_call plumbing, and so the on-chain path can
 * be unit-tested with a stub `ReadContractClient` instead of a real
 * public client.
 */

import type { Address, BAMMessage } from 'bam-sdk';
import { BAM_DECODER_ABI } from 'bam-sdk';

import { DecodeDispatchFailed } from '../errors.js';

export interface ReadContractClient {
  readContract(args: {
    address: Address;
    abi: typeof BAM_DECODER_ABI;
    functionName: 'decode';
    args: readonly [`0x${string}`];
    gas?: bigint;
  }): Promise<readonly [
    readonly { sender: Address; nonce: bigint; contents: `0x${string}` }[],
    `0x${string}`,
  ]>;
}

export interface OnChainDecodeOptions {
  decoderAddress: Address;
  usableBytes: Uint8Array;
  publicClient: ReadContractClient;
  gasCap: bigint;
  timeoutMs: number;
}

export interface OnChainDecodeResult {
  messages: BAMMessage[];
  signatures: Uint8Array[];
}

function bytesToHex(bytes: Uint8Array): `0x${string}` {
  let out = '0x';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out as `0x${string}`;
}

function hexToBytes(hex: `0x${string}`): Uint8Array {
  const cleaned = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (cleaned.length % 2 !== 0) {
    throw new RangeError('invalid hex (odd length)');
  }
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new DecodeDispatchFailed(`${label} timed out after ${ms}ms`)),
          ms
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function splitSignatureData(
  signatureData: Uint8Array,
  messageCount: number
): Uint8Array[] {
  if (messageCount === 0) {
    if (signatureData.length !== 0) {
      throw new DecodeDispatchFailed(
        'on-chain decoder returned signatureData for an empty batch'
      );
    }
    return [];
  }
  if (signatureData.length % messageCount !== 0) {
    throw new DecodeDispatchFailed(
      `on-chain decoder returned ${signatureData.length}-byte signatureData not divisible by ${messageCount} messages`
    );
  }
  const sigSize = signatureData.length / messageCount;
  const out: Uint8Array[] = [];
  for (let i = 0; i < messageCount; i++) {
    out.push(signatureData.slice(i * sigSize, (i + 1) * sigSize));
  }
  return out;
}

export async function callOnChainDecoder(
  opts: OnChainDecodeOptions
): Promise<OnChainDecodeResult> {
  let raw: readonly [
    readonly { sender: Address; nonce: bigint; contents: `0x${string}` }[],
    `0x${string}`,
  ];
  try {
    raw = await withTimeout(
      opts.publicClient.readContract({
        address: opts.decoderAddress,
        abi: BAM_DECODER_ABI,
        functionName: 'decode',
        args: [bytesToHex(opts.usableBytes)],
        gas: opts.gasCap,
      }),
      opts.timeoutMs,
      `decoder ${opts.decoderAddress}`
    );
  } catch (err) {
    if (err instanceof DecodeDispatchFailed) throw err;
    const detail = err instanceof Error ? err.message : String(err);
    throw new DecodeDispatchFailed(
      `on-chain decode at ${opts.decoderAddress} failed: ${detail}`
    );
  }

  const [rawMessages, sigDataHex] = raw;
  const messages: BAMMessage[] = rawMessages.map((m) => ({
    sender: m.sender,
    nonce: m.nonce,
    contents: hexToBytes(m.contents),
  }));
  const signatureData = hexToBytes(sigDataHex);
  const signatures = splitSignatureData(signatureData, messages.length);
  return { messages, signatures };
}
