import { describe, it, expect } from 'vitest';
import {
  buildBPEDictionary,
  bpeEncode,
  bytesToHex,
  decodeBatchBPE,
  decodeBatchBPEPerMessage,
  encodeBatchBPE,
  type BAMMessage,
} from '../../src/index.js';

const CORPUS = new TextEncoder().encode(
  [
    'gm wagmi lfg ',
    'hello world ',
    'the quick brown fox ',
    'bam blob bam blob ',
    'good morning everyone ',
  ]
    .join('')
    .repeat(200)
);

function buildDict() {
  return buildBPEDictionary(CORPUS);
}

function senderHex(seed: number): `0x${string}` {
  let s = '0x';
  for (let i = 0; i < 20; i++) s += ((seed + i * 11) & 0xff).toString(16).padStart(2, '0');
  return s as `0x${string}`;
}

function fakeSig(len: number, seed: number): Uint8Array {
  const b = new Uint8Array(len);
  for (let i = 0; i < len; i++) b[i] = (seed * 31 + i * 7) & 0xff;
  return b;
}

describe('BPE batch codec — aggregate mode', () => {
  it('roundtrips a single message with a fixed-size trailer', () => {
    const dict = buildDict();
    const messages: BAMMessage[] = [
      {
        sender: senderHex(0x11),
        nonce: 1n,
        contents: new TextEncoder().encode('hello world'),
      },
    ];
    const trailer = fakeSig(256, 0xaa);

    const payload = encodeBatchBPE(messages, trailer, dict);
    const { messages: out, signatureData: sig } = decodeBatchBPE(payload, dict, 256);

    expect(out.length).toBe(1);
    expect(out[0].sender.toLowerCase()).toBe(senderHex(0x11));
    expect(out[0].nonce).toBe(1n);
    expect(new TextDecoder().decode(out[0].contents)).toBe('hello world');
    expect(bytesToHex(sig)).toBe(bytesToHex(trailer));
  });

  it('roundtrips three messages with empty contents and max-nonce', () => {
    const dict = buildDict();
    const messages: BAMMessage[] = [
      { sender: senderHex(0x21), nonce: 1n, contents: new TextEncoder().encode('first') },
      { sender: senderHex(0x22), nonce: 2n, contents: new Uint8Array(0) },
      {
        sender: senderHex(0x23),
        nonce: 0xffffffffffffffffn,
        contents: new TextEncoder().encode('third'),
      },
    ];
    const trailer = fakeSig(256, 0xbb);

    const payload = encodeBatchBPE(messages, trailer, dict);
    const decoded = decodeBatchBPE(payload, dict, 256);

    expect(decoded.messages.length).toBe(3);
    expect(decoded.messages[1].contents.length).toBe(0);
    expect(decoded.messages[2].nonce).toBe(0xffffffffffffffffn);
    expect(bytesToHex(decoded.signatureData)).toBe(bytesToHex(trailer));
  });
});

describe('BPE batch codec — per-message mode', () => {
  it('roundtrips with a trailer of sigUnitSize * N', () => {
    const dict = buildDict();
    const sigUnit = 65;
    const messages: BAMMessage[] = [
      { sender: senderHex(0x51), nonce: 10n, contents: new TextEncoder().encode('first') },
      { sender: senderHex(0x52), nonce: 11n, contents: new TextEncoder().encode('second') },
      { sender: senderHex(0x53), nonce: 12n, contents: new TextEncoder().encode('third') },
    ];
    const trailer = fakeSig(sigUnit * messages.length, 0xee);

    const payload = encodeBatchBPE(messages, trailer, dict);
    const decoded = decodeBatchBPEPerMessage(payload, dict, sigUnit);

    expect(decoded.messages.length).toBe(3);
    expect(decoded.signatureData.length).toBe(sigUnit * 3);
    expect(bytesToHex(decoded.signatureData)).toBe(bytesToHex(trailer));
  });
});

describe('BPE batch codec — edge cases', () => {
  it('handles empty payload', () => {
    const dict = buildDict();
    const decoded = decodeBatchBPE(new Uint8Array(0), dict, 256);
    expect(decoded.messages.length).toBe(0);
    expect(decoded.signatureData.length).toBe(0);
  });

  it('handles zero messages with empty trailer', () => {
    const dict = buildDict();
    const payload = encodeBatchBPE([], new Uint8Array(0), dict);
    expect(payload.length).toBe(2); // just the uint16 N=0
    expect(payload[0]).toBe(0);
    expect(payload[1]).toBe(0);
    const decoded = decodeBatchBPE(payload, dict, 0);
    expect(decoded.messages.length).toBe(0);
  });

  it('rejects nonces that overflow uint64', () => {
    const dict = buildDict();
    expect(() =>
      encodeBatchBPE(
        [{ sender: senderHex(1), nonce: 1n << 64n, contents: new Uint8Array(0) }],
        new Uint8Array(0),
        dict
      )
    ).toThrow();
  });

  it('rejects a trailer that overruns the message headers on decode', () => {
    const dict = buildDict();
    const payload = encodeBatchBPE(
      [{ sender: senderHex(1), nonce: 1n, contents: new TextEncoder().encode('hi') }],
      fakeSig(8, 0x10),
      dict
    );
    expect(() => decodeBatchBPE(payload, dict, payload.length)).toThrow();
  });

  it('byte-sweep contents survive the roundtrip (1-byte fallback tier)', () => {
    const dict = buildDict();
    const sweep = new Uint8Array(256);
    for (let i = 0; i < 256; i++) sweep[i] = i;
    const trailer = fakeSig(256, 0xdd);
    const payload = encodeBatchBPE(
      [{ sender: senderHex(0x41), nonce: 7n, contents: sweep }],
      trailer,
      dict
    );
    const decoded = decodeBatchBPE(payload, dict, 256);
    expect(bytesToHex(decoded.messages[0].contents)).toBe(bytesToHex(sweep));
  });
});
