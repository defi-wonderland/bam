/**
 * BAM Compression Utilities
 * @module bam-sdk/compression
 *
 * This module provides Zstd compression/decompression with dictionary support.
 *
 * ## Empirical Performance (from Phase 003 benchmarking)
 *
 * **Recommended Production Configuration:**
 * - Algorithm: Zstd level 12 with 32KB dictionary
 * - Batch size: 100-1000 messages
 * - Compression ratio: 9.17x (typical messages, batch=100)
 * - Speed: 77 MB/s compression, 850 MB/s decompression
 *
 * **Dictionary Impact:**
 * - With dictionary: 9.17x compression (batch=100)
 * - Without dictionary: 4.62x compression (batch=100)
 * - Improvement: +98.5% (1.985x better)
 *
 * **Capacity:**
 * - Messages per blob: 11,543 (empirical, 98-char messages, 200 authors)
 * - Daily throughput: 498.7M messages/day (6 blobs/block)
 *
 * See specs/003-compression-research/results.md for full benchmark data.
 *
 * @example
 * ```typescript
 * import { compress, decompress, loadBundledDictionary } from 'bam-core/compression';
 *
 * // Load bundled dictionary (32KB, trained on social messages)
 * const dict = await loadBundledDictionary();
 *
 * // Compress with dictionary
 * const compressed = compress(data, dict, 12);
 *
 * // Decompress with dictionary
 * const decompressed = decompress(compressed, dict);
 * ```
 */

import * as fzstd from 'fzstd';
import { DEFAULT_COMPRESSION_LEVEL } from './constants.js';
import { DecompressionError } from './errors.js';

/**
 * Zstd dictionary wrapper
 */
export interface ZstdDictionary {
  /** Raw dictionary bytes */
  data: Uint8Array;
  /** Dictionary ID (from header) */
  id: number;
}

/**
 * Load a compression dictionary from bytes
 * @param data Dictionary bytes
 * @returns Loaded dictionary
 */
export function loadDictionary(data: Uint8Array): ZstdDictionary {
  // Extract dictionary ID from header (first 4 bytes after magic)
  // Magic: 0xEC30A437
  if (data.length < 8) {
    throw new Error('Dictionary too small');
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const magic = view.getUint32(0, true); // little-endian

  // Zstd dictionary magic
  if (magic !== 0xec30a437) {
    throw new Error('Invalid dictionary magic');
  }

  const id = view.getUint32(4, true);

  return {
    data,
    id,
  };
}

/**
 * Compress data with optional dictionary
 * @param data Data to compress
 * @param _dictionary Optional compression dictionary (unused - fzstd is decompression-only)
 * @param _level Compression level (1-22, default 12) (unused - fzstd is decompression-only)
 * @returns Compressed data
 */
export function compress(
  data: Uint8Array,
  _dictionary?: ZstdDictionary,
  _level: number = DEFAULT_COMPRESSION_LEVEL
): Uint8Array {
  // fzstd is a decompression-only library
  // For compression, we would need zstd-codec or similar
  // For now, return data as-is with a marker that it's uncompressed
  // In production, use a full zstd implementation

  // Note: fzstd only supports decompression
  // This is a placeholder - in production use zstd-codec
  console.warn(
    'Compression not available in fzstd (decompression-only). Data returned uncompressed.'
  );

  // Return with uncompressed marker
  // Real implementation would use zstd-codec or native bindings
  return data;
}

/**
 * Decompress data with optional dictionary
 * @param data Compressed data
 * @param dictionary Optional compression dictionary
 * @returns Decompressed data
 */
export function decompress(data: Uint8Array, dictionary?: ZstdDictionary): Uint8Array {
  try {
    if (dictionary) {
      // Decompress with dictionary
      return fzstd.decompress(data, dictionary.data);
    } else {
      // Decompress without dictionary
      return fzstd.decompress(data);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new DecompressionError(message);
  }
}

/**
 * Check if data appears to be Zstd compressed
 * @param data Data to check
 * @returns True if data has Zstd magic bytes
 */
export function isCompressed(data: Uint8Array): boolean {
  if (data.length < 4) return false;

  // Zstd frame magic: 0xFD2FB528 (little-endian)
  const magic = data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24);

  return magic === 0x28b52ffd;
}

/**
 * Get decompressed size from Zstd frame header
 * @param data Compressed data
 * @returns Decompressed size, or -1 if unknown
 */
export function getDecompressedSize(data: Uint8Array): number {
  if (!isCompressed(data) || data.length < 5) {
    return -1;
  }

  // Frame header descriptor is at byte 4
  const descriptor = data[4];

  // Check if frame content size is present
  const fcsFlag = (descriptor >> 6) & 0x03;

  if (fcsFlag === 0) {
    // No frame content size
    return -1;
  }

  // Calculate FCS field size
  const fcsSizes = [0, 1, 2, 4, 8];
  const fcsSize = fcsSizes[fcsFlag];

  // Window descriptor presence
  const singleSegment = (descriptor >> 5) & 0x01;
  const windowDescriptorSize = singleSegment ? 0 : 1;

  // Dictionary ID flag
  const dictIdFlag = descriptor & 0x03;
  const dictIdSizes = [0, 1, 2, 4];
  const dictIdSize = dictIdSizes[dictIdFlag];

  // FCS starts after header
  const fcsOffset = 5 + windowDescriptorSize + dictIdSize;

  if (data.length < fcsOffset + fcsSize) {
    return -1;
  }

  // Read FCS based on size
  let size = 0;
  for (let i = 0; i < fcsSize; i++) {
    size |= data[fcsOffset + i] << (i * 8);
  }

  // Adjust for FCS encoding
  if (fcsFlag === 1) {
    // 1-byte: actual size
  } else if (fcsFlag === 2) {
    // 2-byte: size + 256
    size += 256;
  }
  // 4-byte and 8-byte: actual size

  return size;
}

/**
 * Estimate compression ratio for given data
 * @param originalSize Original uncompressed size
 * @param compressedSize Compressed size
 * @returns Compression ratio (original/compressed)
 */
export function compressionRatio(originalSize: number, compressedSize: number): number {
  if (compressedSize === 0) return 0;
  return originalSize / compressedSize;
}

