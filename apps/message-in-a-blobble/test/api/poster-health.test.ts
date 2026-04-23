import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ORIGINAL_FETCH = global.fetch;

describe('api/poster-health — proxy', () => {
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

  it('forwards to /health and returns the body verbatim', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ health: { state: 'ok' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    const { GET } = await import('../../src/app/api/poster-health/route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { health: { state: string } };
    expect(body.health.state).toBe('ok');
  });

  it('returns 502 when the Poster is unreachable', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    const { GET } = await import('../../src/app/api/poster-health/route');
    const res = await GET();
    expect(res.status).toBe(502);
  });
});
