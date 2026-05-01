import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getHealth,
  getPending,
  getStatus,
  getSubmittedBatches,
  PosterConfigError,
  PosterUnreachableError,
} from '../src/lib/poster-client';
import * as posterClient from '../src/lib/poster-client';

const TAG = '0x' + 'aa'.repeat(32);
const BASE = 'http://poster.test';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('poster-client baseUrl handling', () => {
  it('strips trailing slash', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal('fetch', f);
    await getHealth({ baseUrl: 'http://x/' });
    expect(String(f.mock.calls[0][0])).toBe('http://x/health');
  });

  it('throws PosterConfigError on empty baseUrl', async () => {
    await expect(getHealth({ baseUrl: '' })).rejects.toBeInstanceOf(PosterConfigError);
  });
});

describe('getHealth / getStatus', () => {
  it('200 → returns body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ health: { state: 'ok' } })));
    const r = await getHealth({ baseUrl: BASE });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ health: { state: 'ok' } });
  });

  it('non-2xx → returns upstream status without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, 503)));
    const r = await getHealth({ baseUrl: BASE });
    expect(r.status).toBe(503);
  });

  it('network error → throws PosterUnreachableError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    await expect(getStatus({ baseUrl: BASE })).rejects.toBeInstanceOf(PosterUnreachableError);
  });

  it('timeout → throws PosterUnreachableError', async () => {
    const timeoutErr = new Error('aborted');
    timeoutErr.name = 'TimeoutError';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(timeoutErr));
    await expect(getStatus({ baseUrl: BASE })).rejects.toBeInstanceOf(PosterUnreachableError);
  });
});

describe('getPending', () => {
  it('builds /pending with optional query', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({ pending: [] }));
    vi.stubGlobal('fetch', f);
    await getPending({ baseUrl: BASE }, { contentTag: TAG, limit: 25 });
    const url = String(f.mock.calls[0][0]);
    expect(url).toContain('/pending?');
    expect(url).toContain(`contentTag=${encodeURIComponent(TAG)}`);
    expect(url).toContain('limit=25');
  });

  it('omits the querystring when no args are given', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({ pending: [] }));
    vi.stubGlobal('fetch', f);
    await getPending({ baseUrl: BASE });
    const url = String(f.mock.calls[0][0]);
    expect(url).toBe(`${BASE}/pending`);
  });
});

describe('getSubmittedBatches', () => {
  it('builds /submitted-batches with optional query (sinceBlock included)', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({ batches: [] }));
    vi.stubGlobal('fetch', f);
    await getSubmittedBatches({ baseUrl: BASE }, { contentTag: TAG, limit: 10, sinceBlock: '12345' });
    const url = String(f.mock.calls[0][0]);
    expect(url).toContain('/submitted-batches?');
    expect(url).toContain(`contentTag=${encodeURIComponent(TAG)}`);
    expect(url).toContain('limit=10');
    expect(url).toContain('sinceBlock=12345');
  });
});

describe('auth token forwarding', () => {
  it('attaches Authorization: Bearer when authToken is set', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({ status: {} }));
    vi.stubGlobal('fetch', f);
    await getStatus({ baseUrl: BASE, authToken: 'secret-token' });
    const init = f.mock.calls[0][1] as RequestInit;
    expect(init.headers).toEqual({ Authorization: 'Bearer secret-token' });
  });

  it('omits Authorization when authToken is unset', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({ status: {} }));
    vi.stubGlobal('fetch', f);
    await getStatus({ baseUrl: BASE });
    const init = f.mock.calls[0][1] as RequestInit;
    expect(init.headers).toEqual({});
  });

  it('omits Authorization when authToken is empty string', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({ status: {} }));
    vi.stubGlobal('fetch', f);
    await getStatus({ baseUrl: BASE, authToken: '' });
    const init = f.mock.calls[0][1] as RequestInit;
    expect(init.headers).toEqual({});
  });
});

describe('write endpoints are NOT exported (gate G-5 structural check)', () => {
  it('submitMessage is not exported', () => {
    expect((posterClient as Record<string, unknown>).submitMessage).toBeUndefined();
  });

  it('flush is not exported', () => {
    expect((posterClient as Record<string, unknown>).flush).toBeUndefined();
  });

  it('every exported call uses the GET HTTP method', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal('fetch', f);
    await getHealth({ baseUrl: BASE });
    await getStatus({ baseUrl: BASE });
    await getPending({ baseUrl: BASE });
    await getSubmittedBatches({ baseUrl: BASE });
    for (const call of f.mock.calls) {
      const init = call[1] as RequestInit;
      expect(init.method).toBe('GET');
    }
  });
});
