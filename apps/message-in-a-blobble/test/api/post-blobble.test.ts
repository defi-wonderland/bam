import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ORIGINAL_FETCH = global.fetch;

describe('api/post-blobble — proxy', () => {
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

  it('forwards to /flush and returns the Poster response verbatim', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ flushed: '0xtag' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    const { POST } = await import('../../src/app/api/post-blobble/route');
    const res = await POST();
    expect(res.status).toBe(200);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('/flush');
    expect(url).toContain('contentTag=');
  });

  it('returns 502 when the Poster is unreachable', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    const { POST } = await import('../../src/app/api/post-blobble/route');
    const res = await POST();
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('poster_unreachable');
  });
});
