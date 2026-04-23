import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  PosterConfigError,
  PosterUnreachableError,
  flush,
  getHealth,
  getPending,
  getStatus,
  getSubmittedBatches,
  resolvePosterUrl,
  submitMessage,
} from '../../src/lib/poster-client';

const ORIGINAL_FETCH = global.fetch;

describe('resolvePosterUrl', () => {
  beforeEach(() => {
    delete process.env.POSTER_URL;
  });

  it('reads from env', () => {
    process.env.POSTER_URL = 'http://127.0.0.1:8787';
    expect(resolvePosterUrl()).toBe('http://127.0.0.1:8787');
  });

  it('strips trailing slashes', () => {
    process.env.POSTER_URL = 'http://x/';
    expect(resolvePosterUrl()).toBe('http://x');
  });

  it('throws PosterConfigError when env is absent', () => {
    expect(() => resolvePosterUrl()).toThrow(PosterConfigError);
  });

  it('accepts an override argument (tests / SSR contexts)', () => {
    expect(resolvePosterUrl('http://override')).toBe('http://override');
  });
});

describe('poster-client — wrapping fetch', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
  });

  it('submitMessage POSTs the raw envelope + optional hint', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ accepted: true, messageId: '0xabc' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      })
    );
    const res = await submitMessage({
      rawEnvelope: new TextEncoder().encode('{}'),
      hintContentTag: '0x' + 'aa'.repeat(32),
      envUrl: 'http://p',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      `http://p/submit?contentTag=${encodeURIComponent('0x' + 'aa'.repeat(32))}`
    );
    expect((init as { method: string }).method).toBe('POST');
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ accepted: true, messageId: '0xabc' });
  });

  it('passes rejections through verbatim (no remapping)', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ accepted: false, reason: 'unknown_tag' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })
    );
    const res = await submitMessage({
      rawEnvelope: new TextEncoder().encode('{}'),
      envUrl: 'http://p',
    });
    expect(res.status).toBe(400);
    expect((res.body as { reason: string }).reason).toBe('unknown_tag');
  });

  it('getPending / getSubmittedBatches / getStatus / getHealth / flush all wrap fetch', async () => {
    for (const _ of Array.from({ length: 5 })) {
      fetchMock.mockResolvedValueOnce(
        new Response('{}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      );
    }
    await getPending({ contentTag: '0x' + 'aa'.repeat(32), limit: 10, envUrl: 'http://p' });
    await getSubmittedBatches({ envUrl: 'http://p' });
    await getStatus({ envUrl: 'http://p' });
    await getHealth({ envUrl: 'http://p' });
    await flush({ contentTag: '0x' + 'aa'.repeat(32), envUrl: 'http://p' });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('surfaces unreachable as PosterUnreachableError', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(
      getStatus({ envUrl: 'http://nowhere' })
    ).rejects.toBeInstanceOf(PosterUnreachableError);
  });

  it('falls through the raw body when content-type is text/*', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('hello', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      })
    );
    const res = await getStatus({ envUrl: 'http://p' });
    expect(res.body).toBe('hello');
    expect(res.contentType).toMatch(/text\/plain/);
  });
});
