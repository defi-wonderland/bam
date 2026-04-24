import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MAX_MESSAGE_SIZE_BYTES,
  DEFAULT_MAX_CONTENTS_SIZE_BYTES,
  checkSizeBound,
} from '../../src/ingest/size-bound.js';

describe('checkSizeBound', () => {
  it('under-limit payload accepts', () => {
    const raw = new Uint8Array(100);
    expect(checkSizeBound(raw, 1000).ok).toBe(true);
  });

  it('at-limit payload accepts', () => {
    const raw = new Uint8Array(1000);
    expect(checkSizeBound(raw, 1000).ok).toBe(true);
  });

  it('over-limit payload rejects with message_too_large', () => {
    const raw = new Uint8Array(1001);
    const r = checkSizeBound(raw, 1000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('message_too_large');
  });

  it('DEFAULT_MAX_MESSAGE_SIZE_BYTES sits inside blob-usable capacity', () => {
    expect(DEFAULT_MAX_MESSAGE_SIZE_BYTES).toBeGreaterThan(0);
    // Default envelope cap is well under the blob.
    expect(DEFAULT_MAX_MESSAGE_SIZE_BYTES).toBeLessThan(200 * 1024);
  });

  it('DEFAULT_MAX_CONTENTS_SIZE_BYTES < envelope cap (room for JSON framing)', () => {
    expect(DEFAULT_MAX_CONTENTS_SIZE_BYTES).toBeLessThan(DEFAULT_MAX_MESSAGE_SIZE_BYTES);
  });
});
