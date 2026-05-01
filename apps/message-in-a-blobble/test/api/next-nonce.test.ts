import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { MESSAGE_IN_A_BLOBBLE_TAG, TWITTER_TAG } from '@/lib/constants';

const ORIGINAL_FETCH = global.fetch;

const SENDER = '0x' + '11'.repeat(20);
const OTHER = '0x' + '22'.repeat(20);

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
    process.env.READER_URL = 'http://reader.test';
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
    delete process.env.POSTER_URL;
    delete process.env.READER_URL;
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

  it('returns max(nonce)+1 unioned across pending and per-tag confirmed', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        pending: [
          { sender: SENDER, nonce: '3' },
          { sender: OTHER, nonce: '99' }, // ignored — different sender
          { sender: SENDER.toUpperCase(), nonce: '5' }, // case-insensitive match
        ],
      })
    );
    // Reader call per known tag — order matches KNOWN_CONTENT_TAGS.
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        messages: [
          { author: SENDER, nonce: '4' },
          { author: OTHER, nonce: '100' },
        ],
      })
    );
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        messages: [{ author: SENDER, nonce: '7' }],
      })
    );

    const { GET } = await import('../../src/app/api/next-nonce/route');
    const res = await GET(
      new NextRequest(`http://localhost/api/next-nonce?sender=${SENDER}`)
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { nextNonce: string };
    expect(body.nextNonce).toBe('8');

    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls[0]).toContain('http://poster.test/pending');
    expect(urls.some((u) => u.includes('reader.test/messages') && u.includes(MESSAGE_IN_A_BLOBBLE_TAG))).toBe(true);
    expect(urls.some((u) => u.includes('reader.test/messages') && u.includes(TWITTER_TAG))).toBe(true);
  });

  it('returns 0 for a sender with no history', async () => {
    // One Response per call — Response bodies can only be consumed once.
    fetchMock.mockResolvedValueOnce(jsonResponse({ pending: [] }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ messages: [] }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ messages: [] }));
    const { GET } = await import('../../src/app/api/next-nonce/route');
    const res = await GET(
      new NextRequest(`http://localhost/api/next-nonce?sender=${SENDER}`)
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { nextNonce: string };
    expect(body.nextNonce).toBe('0');
  });

  it('returns 502 when the Poster /pending call returns non-200', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'oops' }, 500));
    const { GET } = await import('../../src/app/api/next-nonce/route');
    const res = await GET(
      new NextRequest(`http://localhost/api/next-nonce?sender=${SENDER}`)
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('nonce_lookup_failed');
  });

  it('returns 502 when a Reader tag fetch returns non-200', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ pending: [] }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'reader down' }, 503));
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
