import { describe, it, expect } from 'vitest';

import { DEFAULT_MAX_MESSAGE_SIZE_BYTES, checkSizeBound } from '../../src/ingest/size-bound.js';

describe('checkSizeBound', () => {
  it('accepts a payload well under the bound', () => {
    const res = checkSizeBound(new Uint8Array(10), 1000);
    expect(res.ok).toBe(true);
  });

  it('accepts a payload exactly at the bound', () => {
    const res = checkSizeBound(new Uint8Array(100), 100);
    expect(res.ok).toBe(true);
  });

  it('rejects a payload one byte over the bound with message_too_large', () => {
    const res = checkSizeBound(new Uint8Array(101), 100);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('message_too_large');
  });

  it('exposes a default aligned with BAM batch-format capacity', () => {
    // A single message must fit inside a full blob minus batch overhead.
    // The default must be (a) well below the 128 KiB blob cap, and
    // (b) large enough to hold the longest v1 message.
    expect(DEFAULT_MAX_MESSAGE_SIZE_BYTES).toBeGreaterThan(4 * 1024);
    expect(DEFAULT_MAX_MESSAGE_SIZE_BYTES).toBeLessThan(128 * 1024);
  });
});

describe('DEFAULT_MAX_MESSAGE_SIZE_BYTES — encodes under blob capacity (FU-11)', () => {
  it('a message at the exact default bound encodes into a batch under BLOB_USABLE_CAPACITY', async () => {
    const { estimateBatchSize, BLOB_USABLE_CAPACITY } = await import('bam-sdk');
    const bigContent = 'x'.repeat(DEFAULT_MAX_MESSAGE_SIZE_BYTES);
    const estimated = estimateBatchSize([
      { author: ('0x' + '11'.repeat(20)) as `0x${string}`, timestamp: 1_700_000_000, nonce: 1, content: bigContent },
    ]);
    // `estimateBatchSize` assumes 5x compression by default (social
    // messages are compressible). That's unrealistic for random content,
    // so also check an upper-bound: uncompressed encoded size must fit.
    const uncompressed = estimateBatchSize(
      [
        { author: ('0x' + '11'.repeat(20)) as `0x${string}`, timestamp: 1_700_000_000, nonce: 1, content: bigContent },
      ],
      { compress: false }
    );
    expect(estimated).toBeLessThan(BLOB_USABLE_CAPACITY);
    // Uncompressed path must also fit — a message at the bound mustn't
    // overflow even if its compressibility happens to be poor.
    expect(uncompressed).toBeLessThan(BLOB_USABLE_CAPACITY);
  });
});
