import { describe, expect, it } from 'vitest';

import * as poster from '../src/index.js';

/**
 * Smoke test for the @bam/poster public surface. Guards against
 * accidental removal of exported factories / helpers that the CLI,
 * tests, and consumers rely on.
 */
describe('@bam/poster public surface', () => {
  it('exports the factory + test hook', () => {
    expect(typeof poster.createPoster).toBe('function');
    expect(typeof poster._clearSignerRegistryForTests).toBe('function');
  });

  it('exports store constructors', () => {
    expect(typeof poster.createMemoryStore).toBe('function');
    expect(typeof poster.PostgresBamStore).toBe('function');
    expect(typeof poster.createDbStore).toBe('function');
  });

  it('exports the default validator + batch policy + signer', () => {
    expect(typeof poster.defaultEcdsaValidator).toBe('function');
    expect(typeof poster.defaultBatchPolicy).toBe('function');
    expect(typeof poster.LocalEcdsaSigner).toBe('function');
  });

  it('exports HttpServer', () => {
    expect(typeof poster.HttpServer).toBe('function');
  });

  it('exports rejection enum values', () => {
    expect(Array.isArray(poster.POSTER_REJECTIONS)).toBe(true);
    expect(poster.POSTER_REJECTIONS).toContain('stale_nonce');
    expect(poster.POSTER_REJECTIONS).toContain('content_tag_mismatch');
    expect(poster.POSTER_REJECTIONS).toContain('bad_signature');
    expect(poster.POSTER_REJECTIONS).toContain('message_too_large');
  });

  it('exports default-config constants + reorg clamp helpers', () => {
    expect(typeof poster.DEFAULT_BLOB_CAPACITY_BYTES).toBe('number');
    expect(typeof poster.DEFAULT_MAX_MESSAGE_SIZE_BYTES).toBe('number');
    expect(typeof poster.DEFAULT_REORG_WINDOW).toBe('number');
    expect(typeof poster.MIN_REORG_WINDOW).toBe('number');
    expect(typeof poster.MAX_REORG_WINDOW).toBe('number');
    expect(typeof poster.clampReorgWindow).toBe('function');
    expect(poster.DEFAULT_RATE_LIMIT).toMatchObject({
      windowMs: expect.any(Number),
      maxPerWindow: expect.any(Number),
    });
    expect(poster.DEFAULT_BACKOFF).toMatchObject({
      baseMs: expect.any(Number),
      capMs: expect.any(Number),
      degradedAfterAttempts: expect.any(Number),
      unhealthyAfterAttempts: expect.any(Number),
    });
  });

  it('does NOT expose v1-shaped identifiers (PosterRejection space is closed)', () => {
    // Guard against accidental re-introduction of v1-shaped hint
    // fields. Every rejection reason must be a string enum value.
    for (const r of poster.POSTER_REJECTIONS) {
      expect(typeof r).toBe('string');
    }
  });
});
