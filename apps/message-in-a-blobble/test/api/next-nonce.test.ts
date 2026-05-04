import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const ORIGINAL_FETCH = global.fetch;

const SENDER = '0x' + '11'.repeat(20);
const SENDER_MIXED = '0x' + 'AbCdEf'.repeat(6) + 'AbCd';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('GET /api/next-nonce', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.POSTER_URL = 'http://poster.test';
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
    delete process.env.POSTER_URL;
    vi.resetModules();
  });

  it('rejects a missing or malformed sender with 400', async () => {
    const { GET } = await import('../../src/app/api/next-nonce/route');
    const noSender = await GET(new NextRequest('http://localhost/api/next-nonce'));
    expect(noSender.status).toBe(400);
    const bad = await GET(new NextRequest('http://localhost/api/next-nonce?sender=not-an-address'));
    expect(bad.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('proxies the Poster /nonce/<sender> response on success', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ nextNonce: '11' }));

    const { GET } = await import('../../src/app/api/next-nonce/route');
    const res = await GET(
      new NextRequest(`http://localhost/api/next-nonce?sender=${SENDER}`)
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { nextNonce: string };
    expect(body.nextNonce).toBe('11');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toBe(
      `http://poster.test/nonce/${encodeURIComponent(SENDER.toLowerCase())}`
    );
  });

  it('lower-cases the sender before forwarding to the Poster', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ nextNonce: '0' }));
    const { GET } = await import('../../src/app/api/next-nonce/route');
    await GET(
      new NextRequest(`http://localhost/api/next-nonce?sender=${SENDER_MIXED}`)
    );
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain(SENDER_MIXED.toLowerCase());
    expect(url).not.toContain(SENDER_MIXED);
  });

  it('returns 502 when the Poster returns non-200', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'oops' }, 500));
    const { GET } = await import('../../src/app/api/next-nonce/route');
    const res = await GET(
      new NextRequest(`http://localhost/api/next-nonce?sender=${SENDER}`)
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('nonce_lookup_failed');
  });

  it('returns 502 when the Poster body is missing nextNonce', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ wrong: 'shape' }));
    const { GET } = await import('../../src/app/api/next-nonce/route');
    const res = await GET(
      new NextRequest(`http://localhost/api/next-nonce?sender=${SENDER}`)
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('nonce_lookup_failed');
  });

  it('returns 502 poster_unreachable when the Poster fetch throws', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    const { GET } = await import('../../src/app/api/next-nonce/route');
    const res = await GET(
      new NextRequest(`http://localhost/api/next-nonce?sender=${SENDER}`)
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('poster_unreachable');
  });
});
