/**
 * ZSTD decompression bound (red-team C-4).
 *
 * The SDK's `decodeBatch` happily decompresses any well-formed ZSTD
 * frame; the underlying `fzstd.decompress` allocates the full
 * decompressed size up-front. A malicious blob whose ZSTD frame
 * advertises a 100MB decompressed size would force the Reader to
 * allocate 100MB per batch — DoS-shaped. The Reader bounds this by
 * peeking at the ZSTD frame's Frame Content Size *before* invoking
 * `decodeBatch`.
 *
 * Cap policy: at most `multiplier × usableBytes.length` (default 2×).
 * A 4096-FE blob carries ~127KB of usable payload, so a 2× cap admits
 * up to ~254KB of decompressed plaintext — comfortably above any
 * legitimate batch (densest ECDSA scheme ≈ 90 bytes per message ⇒
 * ~14k messages of plaintext ≤ 127KB even uncompressed).
 *
 * If the ZSTD frame omits Frame Content Size (FCS), we conservatively
 * reject — without an FCS the bound is unenforceable cheaply, and
 * the Poster never produces FCS-less frames.
 *
 * Frame magic + FCS parsing is re-implemented locally rather than
 * reused from `bam-sdk` so the bound check stays self-contained.
 */

import { DecodeDispatchFailed } from '../errors.js';

const BATCH_HEADER_SIZE = 10;
const CODEC_NONE = 0x00;
const CODEC_ZSTD = 0x01;
export const DEFAULT_DECOMPRESS_MULTIPLIER = 2;

// ZSTD frame magic per RFC 8478 §3.1.1: bytes 0x28 0xB5 0x2F 0xFD on
// disk (little-endian uint32 = 0xFD2FB528).
const ZSTD_MAGIC: readonly [number, number, number, number] = [0x28, 0xb5, 0x2f, 0xfd];

export interface ZstdBoundOptions {
  /** Default 2 — caps decompressed size at 2× usable bytes. */
  multiplier?: number;
}

function readU32BE(buf: Uint8Array, offset: number): number {
  return (
    buf[offset] * 0x1000000 +
    (buf[offset + 1] << 16) +
    (buf[offset + 2] << 8) +
    buf[offset + 3]
  );
}

function hasZstdMagic(payload: Uint8Array): boolean {
  if (payload.length < 4) return false;
  for (let i = 0; i < 4; i++) {
    if (payload[i] !== ZSTD_MAGIC[i]) return false;
  }
  return true;
}

/**
 * Parse the ZSTD Frame Header to extract the declared decompressed
 * size (Frame Content Size). Returns `null` when the FCS is absent
 * (per the ZSTD spec, fcsFlag=0 with single-segment unset).
 */
function readFrameContentSize(payload: Uint8Array): number | null {
  if (payload.length < 5) return null;
  const descriptor = payload[4];
  const fcsFlag = (descriptor >> 6) & 0x03;
  const singleSegment = (descriptor >> 5) & 0x01;
  const dictIdFlag = descriptor & 0x03;
  const dictIdSize = [0, 1, 2, 4][dictIdFlag];
  const windowDescriptorSize = singleSegment ? 0 : 1;

  // FCS field size: when fcsFlag=0, the FCS is present iff
  // singleSegment=1 (1-byte FCS).
  let fcsSize: number;
  switch (fcsFlag) {
    case 0:
      fcsSize = singleSegment ? 1 : 0;
      break;
    case 1:
      fcsSize = 2;
      break;
    case 2:
      fcsSize = 4;
      break;
    case 3:
      fcsSize = 8;
      break;
    default:
      fcsSize = 0;
  }
  if (fcsSize === 0) return null;

  const fcsOffset = 5 + windowDescriptorSize + dictIdSize;
  if (payload.length < fcsOffset + fcsSize) return null;

  let size = 0;
  for (let i = 0; i < fcsSize; i++) {
    size += payload[fcsOffset + i] * Math.pow(256, i);
  }
  // 2-byte FCS is offset by 256 per spec.
  if (fcsFlag === 1) size += 256;
  return size;
}

/**
 * Inspect `usableBytes` as a BAM batch header. If the batch advertises
 * the ZSTD codec, refuse to proceed if the frame's declared
 * decompressed size exceeds `multiplier × usableBytes.length`. No-op
 * when the batch is uncompressed.
 *
 * Throws `DecodeDispatchFailed` when the bound is exceeded, when the
 * ZSTD frame omits its decompressed-size header, or when the
 * advertised codec doesn't match the payload bytes' ZSTD magic.
 *
 * Note: `decodeBatch` itself enforces structural checks on the header
 * (length, version, codec id). This pre-check assumes
 * `usableBytes.length >= BATCH_HEADER_SIZE` *only* when the codec byte
 * is CODEC_ZSTD; shorter inputs are passed through and let
 * `decodeBatch` produce the canonical structural error.
 */
export function assertZstdWithinBound(
  usableBytes: Uint8Array,
  options?: ZstdBoundOptions
): void {
  if (usableBytes.length < BATCH_HEADER_SIZE) {
    return;
  }
  const codecId = usableBytes[1];
  if (codecId === CODEC_NONE) return;
  if (codecId !== CODEC_ZSTD) {
    // `decodeBatch` will reject the unknown codec id; let it.
    return;
  }

  const payloadLen = readU32BE(usableBytes, 6);
  if (BATCH_HEADER_SIZE + payloadLen > usableBytes.length) {
    // `decodeBatch` will surface the canonical structural error.
    return;
  }
  const payload = usableBytes.subarray(
    BATCH_HEADER_SIZE,
    BATCH_HEADER_SIZE + payloadLen
  );

  if (!hasZstdMagic(payload)) {
    throw new DecodeDispatchFailed(
      'batch advertises ZSTD codec but payload lacks ZSTD frame magic'
    );
  }
  const declared = readFrameContentSize(payload);
  if (declared === null) {
    throw new DecodeDispatchFailed(
      'ZSTD frame omits Frame Content Size; refusing to decompress without a cheap upper bound'
    );
  }
  const multiplier = options?.multiplier ?? DEFAULT_DECOMPRESS_MULTIPLIER;
  const cap = usableBytes.length * multiplier;
  if (declared > cap) {
    throw new DecodeDispatchFailed(
      `ZSTD frame declares ${declared}-byte decompressed size, exceeds ${multiplier}× cap (${cap} bytes)`
    );
  }
}
