/**
 * Compression module tests
 * Validates dictionary loading and decompression functionality
 */

import { describe, it, expect } from 'vitest';
import {
  loadDictionary,
  decompress,
  isCompressed,
  compressionRatio,
} from '../src/compression.js';
import { loadBundledDictionary } from '../src/compression-node.js';
import { DICTIONARY_SIZE, COMPRESSION_METRICS, CAPACITY_METRICS } from '../src/constants.js';

describe('Dictionary Loading', () => {
  it('should load bundled v1 dictionary', async () => {
    const dict = await loadBundledDictionary();

    expect(dict).toBeDefined();
    expect(dict.data).toBeInstanceOf(Uint8Array);
    expect(dict.data.length).toBe(DICTIONARY_SIZE);
    expect(dict.id).toBeGreaterThan(0);
  });

  it('should validate dictionary magic bytes', async () => {
    const dict = await loadBundledDictionary();

    // Check Zstd dictionary magic: 0xEC30A437
    const view = new DataView(dict.data.buffer, dict.data.byteOffset, dict.data.byteLength);
    const magic = view.getUint32(0, true); // little-endian

    expect(magic).toBe(0xec30a437);
  });

  it('should reject invalid dictionary data', () => {
    const invalidData = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);

    expect(() => loadDictionary(invalidData)).toThrow('Invalid dictionary magic');
  });

  it('should reject too-small dictionary data', () => {
    const tooSmall = new Uint8Array([1, 2, 3]);

    expect(() => loadDictionary(tooSmall)).toThrow('Dictionary too small');
  });
});

describe('Compression Detection', () => {
  it('should detect Zstd magic bytes', () => {
    // Zstd frame magic: 0x28B52FFD (little-endian)
    const compressed = new Uint8Array([0xfd, 0x2f, 0xb5, 0x28, 0x00]);
    expect(isCompressed(compressed)).toBe(true);
  });

  it('should reject non-compressed data', () => {
    const uncompressed = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
    expect(isCompressed(uncompressed)).toBe(false);
  });

  it('should handle too-short data', () => {
    const tooShort = new Uint8Array([0xfd, 0x2f]);
    expect(isCompressed(tooShort)).toBe(false);
  });
});

describe('Compression Ratio Calculation', () => {
  it('should calculate compression ratio', () => {
    const ratio = compressionRatio(1000, 100);
    expect(ratio).toBe(10);
  });

  it('should handle zero compressed size', () => {
    const ratio = compressionRatio(1000, 0);
    expect(ratio).toBe(0);
  });

  it('should match empirical recommended ratio', () => {
    // From Phase 003 benchmarks: 9.17x compression
    const originalSize = 10935; // 100 messages, ~110 bytes each
    const compressedSize = 1193; // Empirical result
    const ratio = compressionRatio(originalSize, compressedSize);

    expect(ratio).toBeCloseTo(COMPRESSION_METRICS.recommended.ratio, 1);
  });
});

describe('Empirical Metrics Validation', () => {
  it('should have correct recommended compression metrics', () => {
    const { recommended } = COMPRESSION_METRICS;

    expect(recommended.ratio).toBe(9.17);
    expect(recommended.level).toBe(12);
    expect(recommended.batchSize).toBe(100);
    expect(recommended.hasDictionary).toBe(true);
    expect(recommended.compressionSpeedMbps).toBeGreaterThan(70);
    expect(recommended.decompressionSpeedMbps).toBeGreaterThan(800);
  });

  it('should show dictionary improvement', () => {
    const improvement = COMPRESSION_METRICS.dictionaryImprovement;

    // Dictionary provides 98.5% improvement for recommended config
    // 9.17x (with dict) / 4.62x (without dict) = 1.985
    expect(improvement).toBeCloseTo(1.985, 2);

    // Verify it matches ratio improvement for recommended config
    const withDict = COMPRESSION_METRICS.recommended.ratio;
    const withoutDict = COMPRESSION_METRICS.noDictionary.ratio;
    const calculatedImprovement = withDict / withoutDict;

    expect(improvement).toBeCloseTo(calculatedImprovement, 2);
  });

  it('should have valid capacity metrics', () => {
    const { messagesPerBlob, dailyCapacity6Blobs } = CAPACITY_METRICS;

    // From empirical scenario (200 authors, 98 chars, 9.17x compression)
    expect(messagesPerBlob).toBe(11543);

    // Daily capacity: 11,543 msgs/blob * 6 blobs/block * 7,200 blocks/day
    const expectedDaily = messagesPerBlob * 6 * 7200;
    expect(dailyCapacity6Blobs).toBe(expectedDaily);
    expect(dailyCapacity6Blobs).toBeGreaterThan(498_000_000); // ~500M msgs/day
  });

  it('should validate batch size recommendations', () => {
    const { minimumBatchSize, targetBatchSize } = CAPACITY_METRICS;

    expect(minimumBatchSize).toBe(100);
    expect(targetBatchSize).toBe(500);
    expect(targetBatchSize).toBeGreaterThanOrEqual(minimumBatchSize);
  });
});

describe('Decompression', () => {
  it('should throw on invalid compressed data', () => {
    const invalidData = new Uint8Array([0, 1, 2, 3]);

    expect(() => decompress(invalidData)).toThrow();
  });

  // Note: Full compression tests would require zstd-codec or similar
  // since fzstd is decompression-only. For now, we validate the API
  // and ensure dictionary loading works correctly.
});

describe('Performance Targets', () => {
  it('should document target compression ratio ≥9x', () => {
    const targetRatio = 9.0;
    const achievedRatio = COMPRESSION_METRICS.recommended.ratio;

    expect(achievedRatio).toBeGreaterThanOrEqual(targetRatio);
  });

  it('should document target capacity ≥10K messages/blob', () => {
    const targetCapacity = 10000;
    const achievedCapacity = CAPACITY_METRICS.messagesPerBlob;

    expect(achievedCapacity).toBeGreaterThan(targetCapacity);
  });

  it('should document Twitter-scale daily capacity', () => {
    const twitterDaily = 500_000_000; // ~500M tweets/day
    const achievedDaily = CAPACITY_METRICS.dailyCapacity6Blobs;

    // Should achieve ~99.7% of Twitter's volume
    const ratio = achievedDaily / twitterDaily;
    expect(ratio).toBeGreaterThan(0.99);
  });
});
