import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const ORIGINAL_FETCH = global.fetch;

describe('api/submitted-batches — proxy', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.POSTER_URL = 'http://poster.local';
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
    delete process.env.POSTER_URL;
    vi.resetModules();
  });

  it('defaults contentTag to MESSAGE_IN_A_BLOBBLE_TAG when not supplied', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ batches: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    const { GET } = await import('../../src/app/api/submitted-batches/route');
    const req = new NextRequest('http://localhost/api/submitted-batches');
    const res = await GET(req);
    expect(res.status).toBe(200);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('contentTag=');
  });

  it('honors an explicit contentTag override', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ batches: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    const { GET } = await import('../../src/app/api/submitted-batches/route');
    const override = '0x' + 'bb'.repeat(32);
    const req = new NextRequest(
      `http://localhost/api/submitted-batches?contentTag=${encodeURIComponent(override)}`
    );
    await GET(req);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain(encodeURIComponent(override));
  });

  it('returns 502 when the Poster is unreachable', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    const { GET } = await import('../../src/app/api/submitted-batches/route');
    const req = new NextRequest('http://localhost/api/submitted-batches');
    const res = await GET(req);
    expect(res.status).toBe(502);
  });
});
