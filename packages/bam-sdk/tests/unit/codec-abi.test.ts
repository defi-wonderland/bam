import { describe, expect, it } from 'vitest';
import { decodeAbiParameters, encodeAbiParameters } from 'viem';

import type { Address, BAMMessage } from '../../src/types.js';
import { decodeBatchABI, encodeBatchABI } from '../../src/codec/abi.js';
import { bytesToHex, hexToBytes } from '../../src/message.js';

function hex(n: number): string {
  return n.toString(16).padStart(2, '0');
}

function makeMessage(seed: number, contentsLen: number): BAMMessage {
  const sender = ('0x' + hex(seed).repeat(20)) as Address;
  const contents = new Uint8Array(contentsLen);
  for (let i = 0; i < contentsLen; i++) contents[i] = (seed + i) & 0xff;
  return { sender, nonce: BigInt(seed * 1000 + 1), contents };
}

function makeSig(seed: number): Uint8Array {
  const out = new Uint8Array(65);
  for (let i = 0; i < 65; i++) out[i] = (seed * 7 + i) & 0xff;
  return out;
}

const ABI_PARAMS = [
  {
    type: 'tuple[]',
    name: 'messages',
    components: [
      { type: 'address', name: 'sender' },
      { type: 'uint64', name: 'nonce' },
      { type: 'bytes', name: 'contents' },
    ],
  },
  { type: 'bytes', name: 'signatureData' },
] as const;

describe('encodeBatchABI', () => {
  it('encodes a single-message batch and round-trips through abi.decode', () => {
    const msgs = [makeMessage(1, 40)];
    const sigs = [makeSig(1)];
    const encoded = encodeBatchABI(msgs, sigs);
    expect(encoded.length).toBeGreaterThan(0);
    // ABI encodings are 32-byte word aligned.
    expect(encoded.length % 32).toBe(0);

    const [decodedMessages, decodedSigData] = decodeAbiParameters(
      ABI_PARAMS,
      bytesToHex(encoded) as `0x${string}`
    );
    expect(decodedMessages.length).toBe(1);
    expect(decodedMessages[0].sender.toLowerCase()).toBe(msgs[0].sender);
    expect(decodedMessages[0].nonce).toBe(msgs[0].nonce);
    expect(decodedSigData.length).toBe(2 + 65 * 2); // 0x + 65 hex bytes
  });

  it('encodes a multi-message batch with concatenated signatureData', () => {
    const msgs = [makeMessage(1, 40), makeMessage(2, 100), makeMessage(3, 7)];
    const sigs = [makeSig(1), makeSig(2), makeSig(3)];
    const encoded = encodeBatchABI(msgs, sigs);

    const [decodedMessages, decodedSigData] = decodeAbiParameters(
      ABI_PARAMS,
      bytesToHex(encoded) as `0x${string}`
    );
    expect(decodedMessages.length).toBe(3);
    // signatureData is 3 * 65 bytes (concatenated parallel sigs).
    expect((decodedSigData.length - 2) / 2).toBe(3 * 65);
    // Per-message contents survive the round-trip.
    expect(decodedMessages[1].nonce).toBe(msgs[1].nonce);
    expect((decodedMessages[2].contents.length - 2) / 2).toBe(7);
  });

  it('encodes an empty batch into a well-formed ABI tuple', () => {
    const encoded = encodeBatchABI([], []);
    expect(encoded.length).toBeGreaterThan(0);
    expect(encoded.length % 32).toBe(0);

    const [decodedMessages, decodedSigData] = decodeAbiParameters(
      ABI_PARAMS,
      bytesToHex(encoded) as `0x${string}`
    );
    expect(decodedMessages.length).toBe(0);
    expect(decodedSigData).toBe('0x');
  });

  it('is deterministic — same input yields identical output', () => {
    const msgs = [makeMessage(1, 40), makeMessage(2, 100)];
    const sigs = [makeSig(1), makeSig(2)];
    const a = encodeBatchABI(msgs, sigs);
    const b = encodeBatchABI(msgs, sigs);
    expect(bytesToHex(a)).toBe(bytesToHex(b));
  });

  // ── Negative cases ─────────────────────────────────────────────────

  it('rejects mismatched message/signature array lengths', () => {
    expect(() => encodeBatchABI([makeMessage(1, 40)], [])).toThrow(RangeError);
    expect(() =>
      encodeBatchABI([makeMessage(1, 40)], [makeSig(1), makeSig(2)])
    ).toThrow(/parallel arrays/);
  });

  it('rejects non-65-byte signatures', () => {
    expect(() => encodeBatchABI([makeMessage(1, 40)], [new Uint8Array(64)])).toThrow(
      RangeError
    );
    expect(() => encodeBatchABI([makeMessage(1, 40)], [new Uint8Array(64)])).toThrow(
      /must be 65 bytes/
    );
  });

  it('rejects non-20-byte sender', () => {
    const bad: BAMMessage = {
      sender: '0x1234' as Address,
      nonce: 0n,
      contents: new Uint8Array(32),
    };
    expect(() => encodeBatchABI([bad], [makeSig(1)])).toThrow(RangeError);
    expect(() => encodeBatchABI([bad], [makeSig(1)])).toThrow(/sender must be 20 bytes/);
  });

  it('rejects out-of-range nonces (negative)', () => {
    const bad: BAMMessage = {
      sender: ('0x' + '11'.repeat(20)) as Address,
      nonce: -1n,
      contents: new Uint8Array(32),
    };
    expect(() => encodeBatchABI([bad], [makeSig(1)])).toThrow(RangeError);
    expect(() => encodeBatchABI([bad], [makeSig(1)])).toThrow(/uint64 range/);
  });

  it('rejects out-of-range nonces (above 2^64-1)', () => {
    const bad: BAMMessage = {
      sender: ('0x' + '11'.repeat(20)) as Address,
      nonce: 0x10000000000000000n, // 2^64
      contents: new Uint8Array(32),
    };
    expect(() => encodeBatchABI([bad], [makeSig(1)])).toThrow(RangeError);
    expect(() => encodeBatchABI([bad], [makeSig(1)])).toThrow(/uint64 range/);
  });
});

describe('decodeBatchABI', () => {
  it('round-trips a single-message batch', () => {
    const msgs = [makeMessage(1, 40)];
    const sigs = [makeSig(1)];
    const decoded = decodeBatchABI(encodeBatchABI(msgs, sigs));
    expect(decoded.messages.length).toBe(1);
    expect(decoded.messages[0].sender.toLowerCase()).toBe(msgs[0].sender);
    expect(decoded.messages[0].nonce).toBe(msgs[0].nonce);
    expect(Array.from(decoded.messages[0].contents)).toEqual(Array.from(msgs[0].contents));
    expect(Array.from(decoded.signatures[0])).toEqual(Array.from(sigs[0]));
  });

  it('round-trips a multi-message batch and preserves signature order', () => {
    const msgs = [makeMessage(1, 40), makeMessage(2, 100), makeMessage(3, 7)];
    const sigs = [makeSig(1), makeSig(2), makeSig(3)];
    const decoded = decodeBatchABI(encodeBatchABI(msgs, sigs));
    expect(decoded.messages.length).toBe(3);
    for (let i = 0; i < 3; i++) {
      expect(decoded.messages[i].sender.toLowerCase()).toBe(msgs[i].sender);
      expect(decoded.messages[i].nonce).toBe(msgs[i].nonce);
      expect(Array.from(decoded.messages[i].contents)).toEqual(Array.from(msgs[i].contents));
      expect(Array.from(decoded.signatures[i])).toEqual(Array.from(sigs[i]));
    }
  });

  it('round-trips an empty batch', () => {
    const decoded = decodeBatchABI(encodeBatchABI([], []));
    expect(decoded.messages).toEqual([]);
    expect(decoded.signatures).toEqual([]);
  });

  // ── Negative cases ─────────────────────────────────────────────────

  it('throws on truncated input (last 32B sliced off)', () => {
    const encoded = encodeBatchABI([makeMessage(1, 40)], [makeSig(1)]);
    const truncated = encoded.slice(0, encoded.length - 32);
    expect(() => decodeBatchABI(truncated)).toThrow();
  });

  it('throws on bytes that are not valid ABI encoding', () => {
    expect(() => decodeBatchABI(new Uint8Array([0x00]))).toThrow();
  });

  it('throws when signatureData length is not a multiple of 65', () => {
    // Build a payload by hand: 1 message but signatureData of length 64.
    const m = makeMessage(1, 40);
    const forged = encodeAbiParameters(
      [
        {
          type: 'tuple[]',
          components: [
            { type: 'address' },
            { type: 'uint64' },
            { type: 'bytes' },
          ],
        },
        { type: 'bytes' },
      ],
      [
        [[m.sender, m.nonce, bytesToHex(m.contents) as `0x${string}`]],
        bytesToHex(new Uint8Array(64)) as `0x${string}`,
      ]
    );
    expect(() => decodeBatchABI(hexToBytes(forged))).toThrow(
      /signatureData length/
    );
  });

  it('throws when signatureData length does not match messages.length × 65', () => {
    // 2 messages, signatureData of length 65 (one short).
    const m1 = makeMessage(1, 40);
    const m2 = makeMessage(2, 40);
    const forged = encodeAbiParameters(
      [
        {
          type: 'tuple[]',
          components: [
            { type: 'address' },
            { type: 'uint64' },
            { type: 'bytes' },
          ],
        },
        { type: 'bytes' },
      ],
      [
        [
          [m1.sender, m1.nonce, bytesToHex(m1.contents) as `0x${string}`],
          [m2.sender, m2.nonce, bytesToHex(m2.contents) as `0x${string}`],
        ],
        bytesToHex(new Uint8Array(65)) as `0x${string}`,
      ]
    );
    expect(() => decodeBatchABI(hexToBytes(forged))).toThrow(
      /does not match 2 × 65/
    );
  });
});
