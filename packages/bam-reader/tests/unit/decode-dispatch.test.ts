import { encodeBatch } from 'bam-sdk';
import type { Address, BAMMessage } from 'bam-sdk';
import { describe, expect, it } from 'vitest';

import { decode } from '../../src/decode/dispatch.js';
import type { ReadContractClient } from '../../src/decode/on-chain-decoder.js';
import { DecodeDispatchFailed } from '../../src/errors.js';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;
const NON_ZERO_DECODER = '0x000000000000000000000000000000000000abcd' as Address;
const SENDER = '0x0000000000000000000000000000000000000001' as Address;

function bytesToHex(bytes: Uint8Array): `0x${string}` {
  let out = '0x';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out as `0x${string}`;
}

function buildBatchBytes(): Uint8Array {
  const messages: BAMMessage[] = [
    { sender: SENDER, nonce: 1n, contents: new Uint8Array([0x01, 0x02, 0x03]) },
    { sender: SENDER, nonce: 2n, contents: new Uint8Array([0xaa, 0xbb]) },
  ];
  const signatures = [new Uint8Array(65).fill(0x11), new Uint8Array(65).fill(0x22)];
  return encodeBatch(messages, signatures).data;
}

function fakePublicClient(handler: ReadContractClient['readContract']): ReadContractClient {
  return { readContract: handler };
}

describe('decode dispatch — zero-address (SDK)', () => {
  it('decodes via the SDK and returns messages + signatures synchronously', async () => {
    const data = buildBatchBytes();
    const result = await decode({
      decoderAddress: ZERO_ADDRESS,
      usableBytes: data,
      gasCap: 50_000_000n,
      timeoutMs: 5_000,
    });
    expect(result.messages.length).toBe(2);
    expect(result.messages[0].nonce).toBe(1n);
    expect(result.messages[1].nonce).toBe(2n);
    expect(result.signatures.length).toBe(2);
    expect(result.signatures[0]).toEqual(new Uint8Array(65).fill(0x11));
    expect(result.signatures[1]).toEqual(new Uint8Array(65).fill(0x22));
  });

  it('propagates structural failures as RangeError', async () => {
    await expect(
      decode({
        decoderAddress: ZERO_ADDRESS,
        usableBytes: new Uint8Array(2), // too short for header
        gasCap: 50_000_000n,
        timeoutMs: 5_000,
      })
    ).rejects.toBeInstanceOf(RangeError);
  });
});

describe('decode dispatch — non-zero (on-chain)', () => {
  it('returns messages + per-message signatures from a successful eth_call', async () => {
    const sigData = new Uint8Array(130);
    sigData.fill(0x11, 0, 65);
    sigData.fill(0x22, 65, 130);
    const client = fakePublicClient(async () => [
      [
        { sender: SENDER, nonce: 1n, contents: '0x010203' as `0x${string}` },
        { sender: SENDER, nonce: 2n, contents: '0xaabb' as `0x${string}` },
      ],
      bytesToHex(sigData),
    ]);
    const result = await decode({
      decoderAddress: NON_ZERO_DECODER,
      usableBytes: new Uint8Array([0xde, 0xad]),
      publicClient: client,
      gasCap: 50_000_000n,
      timeoutMs: 5_000,
    });
    expect(result.messages[0].contents).toEqual(new Uint8Array([0x01, 0x02, 0x03]));
    expect(result.signatures.length).toBe(2);
    expect(result.signatures[0]).toEqual(new Uint8Array(65).fill(0x11));
    expect(result.signatures[1]).toEqual(new Uint8Array(65).fill(0x22));
  });

  it('throws DecodeDispatchFailed on revert', async () => {
    const client = fakePublicClient(async () => {
      throw new Error('execution reverted');
    });
    await expect(
      decode({
        decoderAddress: NON_ZERO_DECODER,
        usableBytes: new Uint8Array([0]),
        publicClient: client,
        gasCap: 50_000_000n,
        timeoutMs: 5_000,
      })
    ).rejects.toBeInstanceOf(DecodeDispatchFailed);
  });

  it('throws DecodeDispatchFailed when the call exceeds the wallclock timeout', async () => {
    const client = fakePublicClient(
      () => new Promise(() => {}) // never resolves
    );
    await expect(
      decode({
        decoderAddress: NON_ZERO_DECODER,
        usableBytes: new Uint8Array([0]),
        publicClient: client,
        gasCap: 50_000_000n,
        timeoutMs: 25,
      })
    ).rejects.toBeInstanceOf(DecodeDispatchFailed);
  });

  it('throws DecodeDispatchFailed on a gas-cap-exceeded error message', async () => {
    const client = fakePublicClient(async () => {
      throw new Error('gas required exceeds allowance');
    });
    await expect(
      decode({
        decoderAddress: NON_ZERO_DECODER,
        usableBytes: new Uint8Array([0]),
        publicClient: client,
        gasCap: 21_000n,
        timeoutMs: 5_000,
      })
    ).rejects.toBeInstanceOf(DecodeDispatchFailed);
  });

  it('throws DecodeDispatchFailed when signatureData is not divisible by message count', async () => {
    const client = fakePublicClient(async () => [
      [
        { sender: SENDER, nonce: 1n, contents: '0x' as `0x${string}` },
        { sender: SENDER, nonce: 2n, contents: '0x' as `0x${string}` },
      ],
      '0x010203' as `0x${string}`, // 3 bytes, can't split among 2 messages
    ]);
    await expect(
      decode({
        decoderAddress: NON_ZERO_DECODER,
        usableBytes: new Uint8Array([0]),
        publicClient: client,
        gasCap: 50_000_000n,
        timeoutMs: 5_000,
      })
    ).rejects.toBeInstanceOf(DecodeDispatchFailed);
  });

  it('throws DecodeDispatchFailed when no public client is provided', async () => {
    await expect(
      decode({
        decoderAddress: NON_ZERO_DECODER,
        usableBytes: new Uint8Array([0]),
        gasCap: 50_000_000n,
        timeoutMs: 5_000,
      })
    ).rejects.toBeInstanceOf(DecodeDispatchFailed);
  });
});
