/**
 * Pins the validation surface on `getNextNonce` — the widget's only
 * authoritative source of per-sender nonce truth. The endpoint
 * contract is "decimal uint64 as string"; both ends of that contract
 * (`decimal` and `uint64`) are load-bearing because the widget has no
 * fallback path: an out-of-shape value either silently mis-counts
 * (producing endless `stale_nonce` retries) or blows up later inside
 * `bam-sdk`'s message-hash code with a generic RangeError. Better to
 * fail fast at the HTTP boundary.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { getNextNonce, UpstreamError } from '../src/poster-reader.js';

const SENDER = '0x1111111111111111111111111111111111111111' as const;

function stubFetchOnce(body: unknown, status = 200): void {
  vi.stubGlobal('fetch', () =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response)
  );
}

describe('getNextNonce', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the parsed bigint on a valid decimal string', async () => {
    stubFetchOnce({ nextNonce: '42' });
    expect(await getNextNonce(SENDER)).toBe(42n);
  });

  it('accepts the uint64 max boundary', async () => {
    stubFetchOnce({ nextNonce: '18446744073709551615' }); // 2^64 - 1
    expect(await getNextNonce(SENDER)).toBe(0xffffffffffffffffn);
  });

  it('rejects values beyond uint64 max with shape error', async () => {
    stubFetchOnce({ nextNonce: '18446744073709551616' }); // 2^64
    await expect(getNextNonce(SENDER)).rejects.toBeInstanceOf(UpstreamError);
    await expect(getNextNonce(SENDER)).rejects.toMatchObject({
      kind: 'shape',
    });
  });

  it('rejects hex strings even though BigInt() would parse them', async () => {
    stubFetchOnce({ nextNonce: '0x10' });
    await expect(getNextNonce(SENDER)).rejects.toMatchObject({ kind: 'shape' });
  });

  it('rejects non-numeric strings', async () => {
    stubFetchOnce({ nextNonce: 'abc' });
    await expect(getNextNonce(SENDER)).rejects.toMatchObject({ kind: 'shape' });
  });

  it('rejects responses where nextNonce is not a string', async () => {
    stubFetchOnce({ nextNonce: 42 });
    await expect(getNextNonce(SENDER)).rejects.toMatchObject({ kind: 'shape' });
  });

  it('rejects responses missing nextNonce entirely', async () => {
    stubFetchOnce({});
    await expect(getNextNonce(SENDER)).rejects.toMatchObject({ kind: 'shape' });
  });

  it('surfaces non-2xx as http UpstreamError', async () => {
    stubFetchOnce({ error: 'not_found' }, 404);
    await expect(getNextNonce(SENDER)).rejects.toMatchObject({
      kind: 'http',
      status: 404,
    });
  });
});
