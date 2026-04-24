import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const ORIGINAL_FETCH = global.fetch;

describe('api/messages — proxy', () => {
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

  it('POST forwards the body wrapped in a Poster envelope and returns the response verbatim', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ accepted: true, messageId: '0xabc' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      })
    );
    const { POST } = await import('../../src/app/api/messages/route');
    const req = new NextRequest('http://localhost/api/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        author: '0x1234567890123456789012345678901234567890',
        timestamp: 1_700_000_000,
        nonce: 1,
        content: 'hello',
        signature: '0x' + '00'.repeat(65),
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { accepted: boolean; messageId: string };
    expect(body).toEqual({ accepted: true, messageId: '0xabc' });

    // Forwarded to Poster's /submit with an envelope body.
    const [, init] = fetchMock.mock.calls[0];
    const forwardedBody = (init as { body: Uint8Array }).body;
    const forwardedJson = JSON.parse(new TextDecoder().decode(forwardedBody));
    expect(forwardedJson.contentTag).toMatch(/^0x[0-9a-f]{64}$/);
    expect(forwardedJson.message.author).toBe('0x1234567890123456789012345678901234567890');
  });

  it('POST returns a rejection response verbatim (no remapping)', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ accepted: false, reason: 'stale_nonce' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })
    );
    const { POST } = await import('../../src/app/api/messages/route');
    const req = new NextRequest('http://localhost/api/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ author: '0x0', timestamp: 0, nonce: 0, content: '', signature: '0x' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { reason: string };
    expect(body.reason).toBe('stale_nonce');
  });

  it('POST returns a stable 502 when the Poster is unreachable', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    const { POST } = await import('../../src/app/api/messages/route');
    const req = new NextRequest('http://localhost/api/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ author: '0x0', timestamp: 0, nonce: 0, content: '', signature: '0x' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('poster_unreachable');
  });

  it('POST backfills contentTag when the body has `message` but no `contentTag`', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ accepted: true, messageHash: '0xabc' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      })
    );
    const { POST } = await import('../../src/app/api/messages/route');
    const req = new NextRequest('http://localhost/api/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: {
          sender: '0x1234567890123456789012345678901234567890',
          nonce: '1',
          contents: '0x' + '00'.repeat(32),
          signature: '0x' + '00'.repeat(65),
        },
      }),
    });
    await POST(req);
    const [, init] = fetchMock.mock.calls[0];
    const forwardedBody = (init as { body: Uint8Array }).body;
    const forwardedJson = JSON.parse(new TextDecoder().decode(forwardedBody));
    // Must have a contentTag even though the client omitted it.
    expect(forwardedJson.contentTag).toMatch(/^0x[0-9a-f]{64}$/);
    expect(forwardedJson.message.sender).toBe('0x1234567890123456789012345678901234567890');
  });

  it('GET forwards to /pending filtered by contentTag', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ pending: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    const { GET } = await import('../../src/app/api/messages/route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pending: unknown[] };
    expect(body.pending).toEqual([]);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('/pending');
    expect(url).toContain('contentTag=');
  });
});
