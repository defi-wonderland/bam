/**
 * Backstop for swapping wagmi for raw `window.ethereum`. The
 * widget's typed-data builder must produce a payload whose digest
 * — under viem's `hashTypedData` — matches the digest
 * `bam-sdk`'s `computeECDSADigest` produces for the same logical
 * message. If they ever drift the Reader will reject every signed
 * comment with a baffling `bad_signature` and the smoke test will
 * fail end-to-end; this test surfaces the drift at the unit level.
 */

import { describe, expect, it } from 'vitest';
import { hashTypedData, type Hex } from 'viem';
import { computeECDSADigest } from 'bam-sdk/browser';

import { buildBamTypedData } from '../src/widget/typed-data.js';

// Real checksummed Ethereum Foundation address — anything legal works,
// but viem's strict checksum rejects all-zeros-with-suffix-lowercase
// vanity strings.
const SENDER = '0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe' as Hex;
const CHAIN_ID = 11155111; // Sepolia

function hex(byte: number, len = 32): Hex {
  return ('0x' + byte.toString(16).padStart(2, '0').repeat(len)) as Hex;
}

describe('typed-data parity with bam-sdk', () => {
  it('digest of a small message matches computeECDSADigest', () => {
    const contents = hex(0xab, 64);
    const nonce = 0n;
    const td = buildBamTypedData({
      sender: SENDER,
      nonce,
      contents,
      chainId: CHAIN_ID,
    });
    // We don't have to pass `EIP712Domain` to viem's hashTypedData —
    // viem derives it. Strip it so the call goes through the same
    // code path bam-sdk uses internally.
    const { EIP712Domain: _domain, ...typesWithoutDomain } = td.types;
    void _domain;

    const widgetDigest = hashTypedData({
      domain: td.domain,
      types: typesWithoutDomain,
      primaryType: 'BAMMessage',
      message: {
        sender: td.message.sender,
        nonce: BigInt(td.message.nonce),
        contents: td.message.contents,
      },
    });

    const sdkDigest = computeECDSADigest(
      {
        sender: SENDER,
        nonce,
        contents: hexToBytes(contents),
      },
      CHAIN_ID
    );
    expect(widgetDigest.toLowerCase()).toBe(sdkDigest.toLowerCase());
  });

  it('digest matches across many varied inputs', () => {
    const fixtures: ReadonlyArray<{
      contentsByte: number;
      contentsLen: number;
      nonce: bigint;
      chainId: number;
    }> = [
      { contentsByte: 0x00, contentsLen: 32, nonce: 0n, chainId: 1 },
      { contentsByte: 0xff, contentsLen: 64, nonce: 1n, chainId: 11155111 },
      {
        contentsByte: 0x42,
        contentsLen: 256,
        nonce: 1234567890123n,
        chainId: 11155111,
      },
      {
        contentsByte: 0x7f,
        contentsLen: 96,
        // close to but below 2^64-1 to exercise uint64 boundary
        nonce: (1n << 63n) - 1n,
        chainId: 17000,
      },
    ];

    for (const f of fixtures) {
      const contents = hex(f.contentsByte, f.contentsLen);
      const td = buildBamTypedData({
        sender: SENDER,
        nonce: f.nonce,
        contents,
        chainId: f.chainId,
      });
      const { EIP712Domain: _d, ...typesWithoutDomain } = td.types;
      void _d;
      const widgetDigest = hashTypedData({
        domain: td.domain,
        types: typesWithoutDomain,
        primaryType: 'BAMMessage',
        message: {
          sender: td.message.sender,
          nonce: BigInt(td.message.nonce),
          contents: td.message.contents,
        },
      });
      const sdkDigest = computeECDSADigest(
        {
          sender: SENDER,
          nonce: f.nonce,
          contents: hexToBytes(contents),
        },
        f.chainId
      );
      const label = `fixture ${f.contentsByte}/${f.contentsLen}/${f.nonce}/${f.chainId}`;
      expect(widgetDigest.toLowerCase(), label).toBe(sdkDigest.toLowerCase());
    }
  });

  it('flipping a single byte in contents changes the digest', () => {
    const contents = hex(0x42, 32);
    const td = buildBamTypedData({
      sender: SENDER,
      nonce: 1n,
      contents,
      chainId: CHAIN_ID,
    });
    const { EIP712Domain: _d, ...typesWithoutDomain } = td.types;
    void _d;
    const d1 = hashTypedData({
      domain: td.domain,
      types: typesWithoutDomain,
      primaryType: 'BAMMessage',
      message: {
        sender: td.message.sender,
        nonce: BigInt(td.message.nonce),
        contents,
      },
    });
    const flipped = (contents.slice(0, -2) + 'ff') as Hex;
    const d2 = hashTypedData({
      domain: td.domain,
      types: typesWithoutDomain,
      primaryType: 'BAMMessage',
      message: {
        sender: td.message.sender,
        nonce: BigInt(td.message.nonce),
        contents: flipped,
      },
    });
    expect(d1).not.toBe(d2);
  });

  it('typed-data declares EIP712Domain (required by eth_signTypedData_v4)', () => {
    const td = buildBamTypedData({
      sender: SENDER,
      nonce: 0n,
      contents: hex(0, 32),
      chainId: CHAIN_ID,
    });
    expect(td.types.EIP712Domain).toBeDefined();
    expect(td.types.EIP712Domain.map((f) => f.name)).toEqual([
      'name',
      'version',
      'chainId',
    ]);
  });

  it('nonce is serialised as a decimal string (uint64 exceeds Number)', () => {
    const td = buildBamTypedData({
      sender: SENDER,
      nonce: (1n << 63n) - 1n,
      contents: hex(0, 32),
      chainId: CHAIN_ID,
    });
    expect(typeof td.message.nonce).toBe('string');
    expect(td.message.nonce).toBe('9223372036854775807');
  });
});

function hexToBytes(hex: string): Uint8Array {
  const c = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(c.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(c.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
