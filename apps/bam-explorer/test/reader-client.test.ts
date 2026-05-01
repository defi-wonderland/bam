import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getBatch,
  getHealth,
  listBatches,
  listConfirmedMessages,
  ReaderConfigError,
  ReaderUnreachableError,
} from '../src/lib/reader-client';

const TAG = '0x' + 'aa'.repeat(32);
const TX_HASH = '0x' + 'cc'.repeat(32);
const BASE = 'http://reader.test';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('reader-client baseUrl handling', () => {
  it('strips trailing slash', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal('fetch', f);
    await getHealth({ baseUrl: 'http://x/' });
    expect(String(f.mock.calls[0][0])).toBe('http://x/health');
  });

  it('throws ReaderConfigError on empty baseUrl', async () => {
    await expect(getHealth({ baseUrl: '' })).rejects.toBeInstanceOf(ReaderConfigError);
  });
});

describe('getHealth', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ok: true })));
  });

  it('returns body on 200', async () => {
    const r = await getHealth({ baseUrl: BASE });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
  });

  it('returns the upstream status on non-2xx without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: 'x' }, 500)));
    const r = await getHealth({ baseUrl: BASE });
    expect(r.status).toBe(500);
  });

  it('throws ReaderUnreachableError on a network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    await expect(getHealth({ baseUrl: BASE })).rejects.toBeInstanceOf(ReaderUnreachableError);
  });

  it('throws ReaderUnreachableError on timeout', async () => {
    const timeoutErr = new Error('aborted');
    timeoutErr.name = 'TimeoutError';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(timeoutErr));
    await expect(getHealth({ baseUrl: BASE })).rejects.toBeInstanceOf(ReaderUnreachableError);
  });
});

describe('listConfirmedMessages', () => {
  it('builds the right query string', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({ messages: [] }));
    vi.stubGlobal('fetch', f);
    await listConfirmedMessages({ baseUrl: BASE }, { contentTag: TAG, status: 'confirmed', limit: 10 });
    const url = String(f.mock.calls[0][0]);
    expect(url).toContain('/messages?');
    expect(url).toContain(`contentTag=${encodeURIComponent(TAG)}`);
    expect(url).toContain('status=confirmed');
    expect(url).toContain('limit=10');
  });

  it('includes batchRef when provided', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({ messages: [] }));
    vi.stubGlobal('fetch', f);
    await listConfirmedMessages({ baseUrl: BASE }, { contentTag: TAG, batchRef: TX_HASH });
    const url = String(f.mock.calls[0][0]);
    expect(url).toContain(`batchRef=${encodeURIComponent(TX_HASH)}`);
  });
});

describe('listBatches', () => {
  it('builds the right query string', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({ batches: [] }));
    vi.stubGlobal('fetch', f);
    await listBatches({ baseUrl: BASE }, { contentTag: TAG, status: 'confirmed', limit: 25 });
    const url = String(f.mock.calls[0][0]);
    expect(url).toContain('/batches?');
    expect(url).toContain(`contentTag=${encodeURIComponent(TAG)}`);
    expect(url).toContain('status=confirmed');
    expect(url).toContain('limit=25');
  });
});

describe('getBatch', () => {
  it('hits /batches/<txHash>', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({ batch: {} }));
    vi.stubGlobal('fetch', f);
    await getBatch({ baseUrl: BASE }, TX_HASH);
    const url = String(f.mock.calls[0][0]);
    expect(url).toBe(`${BASE}/batches/${encodeURIComponent(TX_HASH)}`);
  });

  it('passes through 404 without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: 'not_found' }, 404)));
    const r = await getBatch({ baseUrl: BASE }, TX_HASH);
    expect(r.status).toBe(404);
  });
});
