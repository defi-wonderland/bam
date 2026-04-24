/**
 * BAM ERC-8180 batch codec.
 *
 * ERC-8180 leaves batch encoding decoder-specific; this is BAM's reference
 * decoder for `BAMMessage[]` + parallel scheme-0x01 signatures. No
 * per-author table, no timestamp-delta, no magic bytes — density
 * regression vs. packed codecs is accepted here; ZSTD compression
 * recovers most of it for repetitive payloads.
 *
 * Header layout (uncompressed, big-endian):
 *   byte 0           : version          (0x02)
 *   byte 1           : codec id         (0x00 none | 0x01 zstd)
 *   bytes 2..5       : message count    (uint32 BE)
 *   bytes 6..9       : payload length   (uint32 BE, bytes after header)
 *
 * Payload (possibly compressed): concatenated per-message records.
 *   sender           : 20 bytes
 *   nonce            : uint64 BE (8 bytes)
 *   contents length  : uint32 BE (4 bytes)
 *   contents         : N bytes   (first 32 bytes are contentTag)
 *   signature        : 65 bytes  (scheme 0x01; other schemes deferred)
 *
 * Compression is applied to the concatenated payload as a single ZSTD
 * stream (no dictionary in v1). The payload-length field is the
 * post-compression length; message count is constant across compression.
 *
 * @module bam-sdk/batch
 */

import type { Address, BAMMessage, BatchOptions } from './types.js';
import { compress, decompress, isCompressed } from './compression.js';
import { hexToBytes, bytesToHex } from './message.js';

/**
 * Result of `encodeBatch`. Slimmer than the v1 `EncodedBatch` — no
 * author table, no compression ratio. `size = data.length` is provided
 * for convenience.
 */
export interface EncodedBatch {
  data: Uint8Array;
  messageCount: number;
  codec: 'none' | 'zstd';
  size: number;
}

const BATCH_VERSION = 0x02;
const CODEC_NONE = 0x00;
const CODEC_ZSTD = 0x01;
const HEADER_SIZE = 10;
const SIGNATURE_BYTES = 65;
const RECORD_FIXED_OVERHEAD = 20 + 8 + 4 + SIGNATURE_BYTES; // sender + nonce + len + sig

/**
 * Encode a parallel array of messages and scheme-0x01 signatures into a
 * single batch buffer.
 *
 * Signatures MUST be 65 bytes each; any other length is a caller bug
 * (validated upstream by the Poster's ingest pipeline).
 */
export function encodeBatch(
  messages: BAMMessage[],
  signatures: Uint8Array[],
  options?: BatchOptions
): EncodedBatch {
  if (messages.length !== signatures.length) {
    throw new RangeError(
      `messages and signatures must be parallel arrays (got ${messages.length} vs ${signatures.length})`
    );
  }
  if (messages.length > 0xffffffff) {
    throw new RangeError('too many messages in one batch');
  }

  // The codec byte provisions for ZSTD on the wire; the actual
  // `compress()` path is a no-op shim today (see `compression.ts`).
  // We refuse to advertise ZSTD in the header unless the payload is
  // verifiably ZSTD-framed — otherwise `decodeBatch` would
  // deterministically fail on roundtrip.
  const useZstd = options?.codec === 'zstd';

  // Assemble the uncompressed payload.
  const recordBuffers: Uint8Array[] = [];
  let payloadSize = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const sig = signatures[i];
    if (sig.length !== SIGNATURE_BYTES) {
      throw new RangeError(`signature ${i} must be 65 bytes (got ${sig.length})`);
    }
    const senderBytes = hexToBytes(m.sender);
    if (senderBytes.length !== 20) {
      throw new RangeError(`message ${i} sender must be 20 bytes`);
    }
    if (m.nonce < 0n || m.nonce > 0xffffffffffffffffn) {
      throw new RangeError(`message ${i} nonce out of uint64 range`);
    }
    if (m.contents.length > 0xffffffff) {
      throw new RangeError(`message ${i} contents too large`);
    }

    const rec = new Uint8Array(RECORD_FIXED_OVERHEAD + m.contents.length);
    let o = 0;
    rec.set(senderBytes, o);
    o += 20;
    writeU64BE(rec, o, m.nonce);
    o += 8;
    writeU32BE(rec, o, m.contents.length);
    o += 4;
    rec.set(m.contents, o);
    o += m.contents.length;
    rec.set(sig, o);
    recordBuffers.push(rec);
    payloadSize += rec.length;
  }

  const plain = new Uint8Array(payloadSize);
  let p = 0;
  for (const rec of recordBuffers) {
    plain.set(rec, p);
    p += rec.length;
  }

  const payload = useZstd ? compress(plain) : plain;
  // Only stamp CODEC_ZSTD when `compress` actually produced a ZSTD
  // frame — the in-repo `compress` is a placeholder that returns
  // data unchanged, so advertising ZSTD here would lie to the decoder.
  const zstdActuallyApplied = useZstd && isCompressed(payload);
  const codecId = zstdActuallyApplied ? CODEC_ZSTD : CODEC_NONE;
  if (useZstd && !zstdActuallyApplied) {
    throw new Error(
      'zstd codec requested but compress() did not produce a ZSTD frame; real compression is not yet wired up — call encodeBatch without { codec: "zstd" } until then'
    );
  }

  const data = new Uint8Array(HEADER_SIZE + payload.length);
  data[0] = BATCH_VERSION;
  data[1] = codecId;
  writeU32BE(data, 2, messages.length);
  writeU32BE(data, 6, payload.length);
  data.set(payload, HEADER_SIZE);

  return {
    data,
    messageCount: messages.length,
    codec: zstdActuallyApplied ? 'zstd' : 'none',
    size: data.length,
  };
}

/**
 * Decode a batch buffer back into `BAMMessage[]` + parallel signatures.
 *
 * Rejects: truncated data, unknown codec id, wrong version, payload
 * length beyond the buffer, per-record length running off the payload.
 */
export function decodeBatch(data: Uint8Array): {
  messages: BAMMessage[];
  signatures: Uint8Array[];
} {
  if (data.length < HEADER_SIZE) {
    throw new RangeError(`batch too short: ${data.length} bytes`);
  }
  const version = data[0];
  if (version !== BATCH_VERSION) {
    throw new RangeError(`unsupported batch version 0x${version.toString(16)}`);
  }
  const codecId = data[1];
  if (codecId !== CODEC_NONE && codecId !== CODEC_ZSTD) {
    throw new RangeError(`unknown codec id 0x${codecId.toString(16)}`);
  }
  const messageCount = readU32BE(data, 2);
  const payloadLen = readU32BE(data, 6);
  if (HEADER_SIZE + payloadLen > data.length) {
    throw new RangeError('batch payload extends past buffer');
  }

  const payload = data.subarray(HEADER_SIZE, HEADER_SIZE + payloadLen);
  const plain = codecId === CODEC_ZSTD ? decompress(payload) : payload;

  const messages: BAMMessage[] = [];
  const signatures: Uint8Array[] = [];
  let o = 0;
  for (let i = 0; i < messageCount; i++) {
    if (o + 20 + 8 + 4 > plain.length) {
      throw new RangeError(`record ${i}: header runs past payload`);
    }
    const sender = bytesToHex(plain.slice(o, o + 20)) as Address;
    o += 20;
    const nonce = readU64BE(plain, o);
    o += 8;
    const contentsLen = readU32BE(plain, o);
    o += 4;
    if (o + contentsLen + SIGNATURE_BYTES > plain.length) {
      throw new RangeError(`record ${i}: body runs past payload`);
    }
    const contents = new Uint8Array(plain.slice(o, o + contentsLen));
    o += contentsLen;
    const sig = new Uint8Array(plain.slice(o, o + SIGNATURE_BYTES));
    o += SIGNATURE_BYTES;
    messages.push({ sender, nonce, contents });
    signatures.push(sig);
  }

  if (o !== plain.length) {
    throw new RangeError(`trailing bytes after ${messageCount} records (${plain.length - o} left)`);
  }

  return { messages, signatures };
}

/**
 * Estimate the encoded (post-compression) size of a batch containing
 * `messages`. Conservative: estimates the uncompressed size, which is an
 * upper bound for CODEC_NONE and a working bound for CODEC_ZSTD since
 * ZSTD never grows compressible inputs by more than ~0.01% plus a fixed
 * ~12-byte frame header.
 */
export function estimateBatchSize(messages: BAMMessage[]): number {
  let total = HEADER_SIZE;
  for (const m of messages) {
    total += RECORD_FIXED_OVERHEAD + m.contents.length;
  }
  return total;
}

function writeU32BE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = (value >>> 24) & 0xff;
  buf[offset + 1] = (value >>> 16) & 0xff;
  buf[offset + 2] = (value >>> 8) & 0xff;
  buf[offset + 3] = value & 0xff;
}

function readU32BE(buf: Uint8Array, offset: number): number {
  return (
    buf[offset] * 0x1000000 +
    (buf[offset + 1] << 16) +
    (buf[offset + 2] << 8) +
    buf[offset + 3]
  );
}

function writeU64BE(buf: Uint8Array, offset: number, value: bigint): void {
  for (let i = 7; i >= 0; i--) {
    buf[offset + i] = Number(value & 0xffn);
    value >>= 8n;
  }
}

function readU64BE(buf: Uint8Array, offset: number): bigint {
  let v = 0n;
  for (let i = 0; i < 8; i++) {
    v = (v << 8n) | BigInt(buf[offset + i]);
  }
  return v;
}
