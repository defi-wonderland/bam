/**
 * Tests for the ZSTD decompression bound (red-team C-4). We craft batch
 * buffers whose ZSTD frame *header* declares an out-of-bound
 * decompressed size; the bound check must reject them before any
 * decompression happens. We don't need a valid ZSTD body — the check
 * runs against the frame header alone.
 */

import { describe, expect, it } from 'vitest';

import { DecodeDispatchFailed } from '../../src/errors.js';
import {
  assertZstdWithinBound,
  DEFAULT_DECOMPRESS_MULTIPLIER,
} from '../../src/decode/zstd-bound.js';

const BATCH_HEADER_SIZE = 10;
const BATCH_VERSION = 0x02;
const CODEC_NONE = 0x00;
const CODEC_ZSTD = 0x01;

function writeU32BE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = (value >>> 24) & 0xff;
  buf[offset + 1] = (value >>> 16) & 0xff;
  buf[offset + 2] = (value >>> 8) & 0xff;
  buf[offset + 3] = value & 0xff;
}

/**
 * Build a synthetic ZSTD frame header whose Frame Content Size field
 * declares `declaredSize` decompressed bytes. The body is junk — the
 * bound check only looks at the header.
 *
 * Frame header layout (single-segment, no dict, FCS=4 bytes):
 *   byte 0..3  : magic 0xFD2FB528 (little-endian)
 *   byte 4     : descriptor (FCS flag 2, single-segment 1, dict id 0)
 *   byte 5..8  : Frame Content Size (4 bytes, little-endian)
 */
function craftZstdFrameHeader(declaredSize: number): Uint8Array {
  const frame = new Uint8Array(13);
  // magic
  frame[0] = 0x28;
  frame[1] = 0xb5;
  frame[2] = 0x2f;
  frame[3] = 0xfd;
  // descriptor: fcsFlag=2 (4-byte FCS) → bits 6-7 = 0b10; singleSegment=1 (bit 5)
  frame[4] = (2 << 6) | (1 << 5);
  // FCS, 4 bytes little-endian
  frame[5] = declaredSize & 0xff;
  frame[6] = (declaredSize >>> 8) & 0xff;
  frame[7] = (declaredSize >>> 16) & 0xff;
  frame[8] = (declaredSize >>> 24) & 0xff;
  // 4 junk body bytes — bound check never reads them.
  frame[9] = 0x00;
  frame[10] = 0x00;
  frame[11] = 0x00;
  frame[12] = 0x00;
  return frame;
}

function buildZstdBatch(declaredSize: number, totalBlobLen: number): Uint8Array {
  const frame = craftZstdFrameHeader(declaredSize);
  const total = new Uint8Array(totalBlobLen);
  total[0] = BATCH_VERSION;
  total[1] = CODEC_ZSTD;
  writeU32BE(total, 2, 1); // messageCount
  writeU32BE(total, 6, frame.length); // payloadLen
  total.set(frame, BATCH_HEADER_SIZE);
  return total;
}

describe('assertZstdWithinBound', () => {
  it('passes through when codec is CODEC_NONE', () => {
    const buf = new Uint8Array(BATCH_HEADER_SIZE);
    buf[0] = BATCH_VERSION;
    buf[1] = CODEC_NONE;
    expect(() => assertZstdWithinBound(buf)).not.toThrow();
  });

  it('rejects an in-bound ZSTD frame whose declared size exceeds 2× the cap', () => {
    const totalLen = 1024;
    const cap = totalLen * DEFAULT_DECOMPRESS_MULTIPLIER;
    const buf = buildZstdBatch(cap + 1, totalLen);
    expect(() => assertZstdWithinBound(buf)).toThrow(DecodeDispatchFailed);
    expect(() => assertZstdWithinBound(buf)).toThrow(/exceeds.*cap/);
  });

  it('admits a ZSTD frame whose declared size sits at the cap', () => {
    const totalLen = 1024;
    const cap = totalLen * DEFAULT_DECOMPRESS_MULTIPLIER;
    const buf = buildZstdBatch(cap, totalLen);
    expect(() => assertZstdWithinBound(buf)).not.toThrow();
  });

  it('respects an explicit multiplier override', () => {
    const totalLen = 1024;
    const buf = buildZstdBatch(totalLen * 4, totalLen);
    expect(() => assertZstdWithinBound(buf, { multiplier: 4 })).not.toThrow();
    expect(() => assertZstdWithinBound(buf, { multiplier: 3 })).toThrow(
      DecodeDispatchFailed
    );
  });

  it('rejects ZSTD-advertising payloads that lack the ZSTD frame magic', () => {
    const buf = new Uint8Array(BATCH_HEADER_SIZE + 10);
    buf[0] = BATCH_VERSION;
    buf[1] = CODEC_ZSTD;
    writeU32BE(buf, 2, 1);
    writeU32BE(buf, 6, 10);
    // payload is all zeros — no ZSTD magic
    expect(() => assertZstdWithinBound(buf)).toThrow(DecodeDispatchFailed);
    expect(() => assertZstdWithinBound(buf)).toThrow(/lacks ZSTD frame magic/);
  });

  it('rejects ZSTD frames that omit Frame Content Size', () => {
    const buf = new Uint8Array(BATCH_HEADER_SIZE + 5);
    buf[0] = BATCH_VERSION;
    buf[1] = CODEC_ZSTD;
    writeU32BE(buf, 2, 1);
    writeU32BE(buf, 6, 5);
    // frame magic
    buf[BATCH_HEADER_SIZE] = 0x28;
    buf[BATCH_HEADER_SIZE + 1] = 0xb5;
    buf[BATCH_HEADER_SIZE + 2] = 0x2f;
    buf[BATCH_HEADER_SIZE + 3] = 0xfd;
    // descriptor: fcsFlag=0, no FCS field present
    buf[BATCH_HEADER_SIZE + 4] = 0;
    expect(() => assertZstdWithinBound(buf)).toThrow(DecodeDispatchFailed);
    expect(() => assertZstdWithinBound(buf)).toThrow(/omits Frame Content Size/);
  });

  it('passes through inputs shorter than the batch header (decoder will produce structural error)', () => {
    expect(() => assertZstdWithinBound(new Uint8Array(4))).not.toThrow();
  });
});
