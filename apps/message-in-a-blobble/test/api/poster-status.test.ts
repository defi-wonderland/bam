import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ORIGINAL_FETCH = global.fetch;

describe('api/poster-status — proxy', () => {
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

  it('forwards to /status and returns the Poster response verbatim', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: {
            walletAddress: '0x' + '11'.repeat(20),
            walletBalanceWei: '1000000000000000000',
            configuredTags: ['0x' + 'aa'.repeat(32)],
            pendingByTag: [],
            lastSubmittedByTag: [],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    const { GET } = await import('../../src/app/api/poster-status/route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: { walletAddress: string } };
    expect(body.status.walletAddress).toMatch(/^0x/);
  });

  it('returns 502 when POSTER_URL is unreachable', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    const { GET } = await import('../../src/app/api/poster-status/route');
    const res = await GET();
    expect(res.status).toBe(502);
  });

  it('returns 500 when POSTER_URL is absent', async () => {
    delete process.env.POSTER_URL;
    const { GET } = await import('../../src/app/api/poster-status/route');
    const res = await GET();
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('poster_url_not_configured');
  });
});
