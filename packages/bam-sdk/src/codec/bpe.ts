/**
 * BPE batch codec for the on-chain BPEDecoder.sol.
 *
 * Wire format (matches `packages/bam-contracts/src/decoders/BPEDecoder.sol`,
 * which is the Solidity port of vbuterin/SocialBlobs decoder.vy):
 *
 *   [0..2)        N                 -- uint16 big-endian, message count
 *   [2..2+2N)     offsets[0..N-1]   -- uint16 big-endian, byte offset of each body
 *   [2+2N..-S)    bodies            -- per-message: sender(20) | nonce(8 BE) | bpeEncoded(contents)
 *   [-S..]        signatureData     -- S bytes, opaque to the decoder
 *
 * The encoder treats `signatureData` as opaque bytes, mirroring the contract's
 * `IERC_BAM_Decoder.signatureData` return: callers pass whatever the matching
 * signature registry expects (a 256-byte BLS aggregate, an N*65-byte concat of
 * ECDSA sigs, an N*64-byte concat of Schnorr sigs, etc.). The encoder does not
 * compute or validate sigs.
 *
 * @module bam-sdk/codec/bpe
 */

import { bpeEncode, bpeDecode, type BPEDictionary } from '../bpe.js';
import { hexToBytes, bytesToHex } from '../message.js';
import type { Address, BAMMessage } from '../types.js';

const RECORD_HEADER = 20 + 8; // sender + nonce
const HEADER_BASE = 2; // uint16 message count

function u16beWrite(buf: Uint8Array, offset: number, value: number): void {
  if (value < 0 || value > 0xffff) throw new RangeError(`uint16 out of range: ${value}`);
  buf[offset] = (value >>> 8) & 0xff;
  buf[offset + 1] = value & 0xff;
}

function u64beWrite(buf: Uint8Array, offset: number, value: bigint): void {
  if (value < 0n || value > 0xffffffffffffffffn) {
    throw new RangeError(`uint64 out of range: ${value}`);
  }
  let v = value;
  for (let i = 7; i >= 0; i--) {
    buf[offset + i] = Number(v & 0xffn);
    v >>= 8n;
  }
}

function u16beRead(buf: Uint8Array, offset: number): number {
  return (buf[offset] << 8) | buf[offset + 1];
}

function u64beRead(buf: Uint8Array, offset: number): bigint {
  let v = 0n;
  for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(buf[offset + i]);
  return v;
}

/**
 * Encode messages + an opaque signature trailer into the BPEDecoder wire format.
 *
 * Throws `RangeError` for caller bugs validated directly: N > 65535, nonce out
 * of uint64 range, encoded body+headers overflowing uint16 offsets, sender
 * length wrong.
 *
 * @param messages       Messages to include. `contents` is BPE-compressed per message.
 * @param signatureData  Opaque trailer bytes (e.g. BLS aggregate or concatenated ECDSA sigs).
 * @param dict           BPE dictionary; must match the on-chain BPEDictionary by content.
 */
export function encodeBatchBPE(
  messages: BAMMessage[],
  signatureData: Uint8Array,
  dict: BPEDictionary
): Uint8Array {
  const n = messages.length;
  if (n > 0xffff) throw new RangeError(`too many messages: ${n}`);

  // Precompute compressed bodies (we need their lengths to lay out offsets).
  const encoded: Uint8Array[] = new Array(n);
  for (let i = 0; i < n; i++) {
    encoded[i] = bpeEncode(messages[i].contents, dict);
  }

  const headerSize = HEADER_BASE + 2 * n;
  const offsets: number[] = new Array(n);
  let cursor = headerSize;
  let bodiesTotal = 0;
  for (let i = 0; i < n; i++) {
    if (cursor > 0xffff) throw new RangeError(`message ${i} offset overflows uint16: ${cursor}`);
    offsets[i] = cursor;
    const bodyLen = RECORD_HEADER + encoded[i].length;
    cursor += bodyLen;
    bodiesTotal += bodyLen;
  }

  const total = headerSize + bodiesTotal + signatureData.length;
  const out = new Uint8Array(total);

  u16beWrite(out, 0, n);
  for (let i = 0; i < n; i++) u16beWrite(out, 2 + i * 2, offsets[i]);

  for (let i = 0; i < n; i++) {
    const m = messages[i];
    const senderBytes = hexToBytes(m.sender);
    if (senderBytes.length !== 20) throw new RangeError(`message ${i} sender must be 20 bytes`);
    if (m.nonce < 0n || m.nonce > 0xffffffffffffffffn) {
      throw new RangeError(`message ${i} nonce out of uint64 range`);
    }
    const base = offsets[i];
    out.set(senderBytes, base);
    u64beWrite(out, base + 20, m.nonce);
    out.set(encoded[i], base + 28);
  }

  out.set(signatureData, headerSize + bodiesTotal);
  return out;
}

/**
 * Decode a BPE-format batch back into messages + the opaque signature trailer.
 *
 * @param payload         Wire-format bytes produced by `encodeBatchBPE` or the on-chain encoder.
 * @param dict            Same BPE dictionary used at encode time.
 * @param signatureSize   Length of the opaque trailer. For aggregate mode this is the fixed
 *                        trailer size; for per-message mode pass `sigUnitSize * N` (or use
 *                        `decodeBatchBPEPerMessage` which infers it from N).
 */
export function decodeBatchBPE(
  payload: Uint8Array,
  dict: BPEDictionary,
  signatureSize: number
): { messages: BAMMessage[]; signatureData: Uint8Array } {
  if (!Number.isInteger(signatureSize) || signatureSize < 0) {
    throw new RangeError(`signatureSize must be a non-negative integer, got ${signatureSize}`);
  }
  if (payload.length === 0) {
    return { messages: [], signatureData: new Uint8Array(0) };
  }
  if (payload.length < 2) {
    throw new RangeError(`payload too short: ${payload.length}`);
  }
  if (signatureSize > payload.length) {
    throw new RangeError(
      `signatureSize ${signatureSize} exceeds payload length ${payload.length}`
    );
  }
  const n = u16beRead(payload, 0);
  const headerSize = HEADER_BASE + 2 * n;
  const sigStart = payload.length - signatureSize;
  if (sigStart < headerSize) {
    throw new RangeError(`signatureSize ${signatureSize} would overrun message headers`);
  }

  const messages: BAMMessage[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const startOff = u16beRead(payload, 2 + i * 2);
    const endOff = i + 1 < n ? u16beRead(payload, 2 + (i + 1) * 2) : sigStart;
    if (endOff < startOff + RECORD_HEADER) {
      throw new RangeError(`message ${i} body too short: ${endOff - startOff} bytes`);
    }
    if (endOff > sigStart) {
      throw new RangeError(`message ${i} body overruns signature trailer`);
    }
    const sender = ('0x' + bytesToHex(payload.slice(startOff, startOff + 20)).slice(2)) as Address;
    const nonce = u64beRead(payload, startOff + 20);
    const encoded = payload.slice(startOff + 28, endOff);
    messages[i] = { sender, nonce, contents: bpeDecode(encoded, dict) };
  }

  return {
    messages,
    signatureData: payload.slice(sigStart),
  };
}

/**
 * Convenience wrapper that derives the trailer size from a per-message unit size.
 * Equivalent to `decodeBatchBPE(payload, dict, sigUnitSize * N)`, where N is read
 * from `payload[0..2)`.
 */
export function decodeBatchBPEPerMessage(
  payload: Uint8Array,
  dict: BPEDictionary,
  sigUnitSize: number
): { messages: BAMMessage[]; signatureData: Uint8Array } {
  if (payload.length === 0) return { messages: [], signatureData: new Uint8Array(0) };
  if (payload.length < 2) throw new RangeError(`payload too short: ${payload.length}`);
  const n = u16beRead(payload, 0);
  return decodeBatchBPE(payload, dict, sigUnitSize * n);
}
