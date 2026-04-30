import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { encodeAbiParameters } from 'viem';

import type { Address, BAMMessage } from '../../src/types.js';
import { decodeBatchABI, encodeBatchABI } from '../../src/codec/abi.js';

const SIGNATURE_BYTES = 65;
const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'vectors', 'codec-abi');

interface Fixture {
  name: string;
  messageCount: number;
  messages: { sender: Address; nonce: string; contents: `0x${string}` }[];
  signatures: `0x${string}`[];
  expectedBytes: `0x${string}`;
}

function loadFixture(name: string): Fixture {
  const path = join(FIXTURES_DIR, `${name}.json`);
  return JSON.parse(readFileSync(path, 'utf8')) as Fixture;
}

function fixtureToInput(f: Fixture): { messages: BAMMessage[]; signatures: Uint8Array[] } {
  return {
    messages: f.messages.map((m) => ({
      sender: m.sender,
      nonce: BigInt(m.nonce),
      contents: hexStringToBytes(m.contents),
    })),
    signatures: f.signatures.map((s) => hexStringToBytes(s)),
  };
}

function hexStringToBytes(hex: `0x${string}`): Uint8Array {
  const len = (hex.length - 2) / 2;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = parseInt(hex.slice(2 + i * 2, 2 + i * 2 + 2), 16);
  }
  return out;
}

function hex(n: number): string {
  return (n & 0xff).toString(16).padStart(2, '0');
}

function makeMessage(seed: number, contentsLen: number): BAMMessage {
  const sender = ('0x' + hex(seed).repeat(20)) as Address;
  const contents = new Uint8Array(contentsLen);
  for (let i = 0; i < contentsLen; i++) contents[i] = (seed + i * 7) & 0xff;
  return { sender, nonce: BigInt(seed * 1000 + 1), contents };
}

function makeSignature(seed: number): Uint8Array {
  const sig = new Uint8Array(SIGNATURE_BYTES);
  for (let i = 0; i < SIGNATURE_BYTES; i++) sig[i] = (seed * 13 + i) & 0xff;
  return sig;
}

function makePair(seed: number, contentsLen: number) {
  return {
    message: makeMessage(seed, contentsLen),
    signature: makeSignature(seed),
  };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

describe('encodeBatchABI / decodeBatchABI (fixture-driven)', () => {
  // Single source of truth: the same JSON files are read by the forge
  // round-trip test in `packages/bam-contracts/test/ABIDecoderRoundtrip.t.sol`.
  const fixtureNames = ['empty', 'one-message', 'four-messages', 'two-fifty-six-messages'];

  for (const name of fixtureNames) {
    it(`${name}: encoder bytes match committed fixture`, () => {
      const f = loadFixture(name);
      const { messages, signatures } = fixtureToInput(f);
      const encoded = encodeBatchABI(messages, signatures);
      const expected = hexStringToBytes(f.expectedBytes);
      expect(encoded.length).toBe(expected.length);
      expect(Array.from(encoded)).toEqual(Array.from(expected));
    });

    it(`${name}: decode round-trips back to the input`, () => {
      const f = loadFixture(name);
      const { messages, signatures } = fixtureToInput(f);
      const data = hexStringToBytes(f.expectedBytes);
      const decoded = decodeBatchABI(data);
      expect(decoded.messages.length).toBe(messages.length);
      expect(decoded.signatures.length).toBe(signatures.length);
      for (let i = 0; i < messages.length; i++) {
        expect(decoded.messages[i].sender.toLowerCase()).toBe(messages[i].sender.toLowerCase());
        expect(decoded.messages[i].nonce).toBe(messages[i].nonce);
        expect(Array.from(decoded.messages[i].contents)).toEqual(Array.from(messages[i].contents));
        expect(Array.from(decoded.signatures[i])).toEqual(Array.from(signatures[i]));
      }
    });
  }

  it('empty input encoder yields zero-length payload', () => {
    const data = encodeBatchABI([], []);
    expect(data.length).toBe(0);
    const decoded = decodeBatchABI(data);
    expect(decoded.messages).toEqual([]);
    expect(decoded.signatures).toEqual([]);
  });

  it('signatureData layout invariant: bytes[i*65..(i+1)*65] is sig_i', () => {
    // Build a 5-message batch, then dig into the raw ABI to confirm the
    // concatenated layout. We re-decode the outer envelope ourselves
    // (not via decodeBatchABI) to exercise the byte-level invariant
    // directly — this is C-1's regression guard.
    const messages: BAMMessage[] = [];
    const signatures: Uint8Array[] = [];
    for (let i = 1; i <= 5; i++) {
      const p = makePair(i, 24);
      messages.push(p.message);
      signatures.push(p.signature);
    }
    const data = encodeBatchABI(messages, signatures);

    // decodeBatchABI must return the per-message slices from the
    // concatenated `signatureData` we just encoded.
    const decoded = decodeBatchABI(data);
    expect(decoded.signatures.length).toBe(5);
    for (let i = 0; i < 5; i++) {
      expect(Array.from(decoded.signatures[i])).toEqual(Array.from(signatures[i]));
    }

    // Construct an ABI payload by hand with the SAME messages but a
    // raw `signatureData` blob assembled as concat(sig_0..sig_n-1).
    // The two encodings MUST match byte-for-byte — proves the layout.
    const sigBlob = new Uint8Array(SIGNATURE_BYTES * signatures.length);
    for (let i = 0; i < signatures.length; i++) {
      sigBlob.set(signatures[i], i * SIGNATURE_BYTES);
    }
    const sigBlobHex = ('0x' + Array.from(sigBlob).map((b) => b.toString(16).padStart(2, '0')).join('')) as `0x${string}`;
    const messagesAbi = messages.map((m) => ({
      sender: m.sender,
      nonce: m.nonce,
      contents: ('0x' + Array.from(m.contents).map((b) => b.toString(16).padStart(2, '0')).join('')) as `0x${string}`,
    }));
    const handBuiltHex = encodeAbiParameters(
      [
        {
          type: 'tuple[]',
          components: [
            { type: 'address', name: 'sender' },
            { type: 'uint64', name: 'nonce' },
            { type: 'bytes', name: 'contents' },
          ],
        },
        { type: 'bytes' },
      ],
      [messagesAbi, sigBlobHex]
    );
    const handBuilt = new Uint8Array(handBuiltHex.length / 2 - 1);
    for (let i = 0; i < handBuilt.length; i++) {
      handBuilt[i] = parseInt(handBuiltHex.slice(2 + i * 2, 2 + i * 2 + 2), 16);
    }
    expect(bytesEqual(data, handBuilt)).toBe(true);
  });

  describe('RangeError on malformed input', () => {
    it('truncated payload (1 byte)', () => {
      expect(() => decodeBatchABI(new Uint8Array([0x00]))).toThrow(RangeError);
    });

    it('truncated payload (31 bytes — less than one ABI word)', () => {
      expect(() => decodeBatchABI(new Uint8Array(31))).toThrow(RangeError);
    });

    it('not-ABI gibberish at length 64', () => {
      // A 64-byte buffer cannot be a valid `(Message[], bytes)` envelope
      // — the ABI head alone for that tuple is 64 bytes, leaving zero room
      // for the array length, so decoding must throw.
      const bogus = new Uint8Array(64);
      for (let i = 0; i < 64; i++) bogus[i] = (i * 7 + 13) & 0xff;
      expect(() => decodeBatchABI(bogus)).toThrow(RangeError);
    });

    it('decoder: signature count does not match message count', () => {
      // Hand-build a wire payload with 2 messages but only 1 signature
      // worth of bytes. The outer ABI envelope is well-formed; the
      // count check inside decodeBatchABI catches the mismatch.
      const m1 = makeMessage(3, 16);
      const m2 = makeMessage(4, 16);
      const messagesAbi = [m1, m2].map((m) => ({
        sender: m.sender,
        nonce: m.nonce,
        contents: ('0x' + Array.from(m.contents).map((b) => b.toString(16).padStart(2, '0')).join('')) as `0x${string}`,
      }));
      const sigBlob = makeSignature(1); // length 65 — only enough for 1 message
      const sigBlobHex = ('0x' + Array.from(sigBlob).map((b) => b.toString(16).padStart(2, '0')).join('')) as `0x${string}`;
      const wireHex = encodeAbiParameters(
        [
          {
            type: 'tuple[]',
            components: [
              { type: 'address', name: 'sender' },
              { type: 'uint64', name: 'nonce' },
              { type: 'bytes', name: 'contents' },
            ],
          },
          { type: 'bytes' },
        ],
        [messagesAbi, sigBlobHex]
      );
      const wire = new Uint8Array(wireHex.length / 2 - 1);
      for (let i = 0; i < wire.length; i++) {
        wire[i] = parseInt(wireHex.slice(2 + i * 2, 2 + i * 2 + 2), 16);
      }
      expect(() => decodeBatchABI(wire)).toThrow(RangeError);
    });

    it('mismatched lengths: more sigs than messages', () => {
      const { message } = makePair(1, 16);
      const sigs = [makeSignature(1), makeSignature(2)];
      // Caller-side bug — must throw before producing wire bytes.
      expect(() => encodeBatchABI([message], sigs)).toThrow(RangeError);
    });

    it('mismatched lengths: more messages than sigs', () => {
      const messages = [makeMessage(1, 16), makeMessage(2, 16)];
      const sigs = [makeSignature(1)];
      expect(() => encodeBatchABI(messages, sigs)).toThrow(RangeError);
    });

    it('signature length not 65 (encoder rejects)', () => {
      const { message } = makePair(1, 16);
      expect(() => encodeBatchABI([message], [new Uint8Array(64)])).toThrow(RangeError);
    });

    it('decoder: signatureData length not divisible by 65', () => {
      // Build a real batch, then re-encode with a doctored sig blob whose
      // length is messages.length * 65 - 1 (off-by-one). The outer ABI
      // envelope is well-formed; the inner length check trips.
      const { message } = makePair(1, 16);
      const messagesAbi = [
        {
          sender: message.sender,
          nonce: message.nonce,
          contents: ('0x' + Array.from(message.contents).map((b) => b.toString(16).padStart(2, '0')).join('')) as `0x${string}`,
        },
      ];
      const badSig = new Uint8Array(64);
      const badSigHex = ('0x' + Array.from(badSig).map((b) => b.toString(16).padStart(2, '0')).join('')) as `0x${string}`;
      const wireHex = encodeAbiParameters(
        [
          {
            type: 'tuple[]',
            components: [
              { type: 'address', name: 'sender' },
              { type: 'uint64', name: 'nonce' },
              { type: 'bytes', name: 'contents' },
            ],
          },
          { type: 'bytes' },
        ],
        [messagesAbi, badSigHex]
      );
      const wire = new Uint8Array(wireHex.length / 2 - 1);
      for (let i = 0; i < wire.length; i++) {
        wire[i] = parseInt(wireHex.slice(2 + i * 2, 2 + i * 2 + 2), 16);
      }
      expect(() => decodeBatchABI(wire)).toThrow(RangeError);
    });
  });
});
