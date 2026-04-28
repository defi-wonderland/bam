import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  ReaderConfigError,
  ReaderUnreachableError,
  getBatch,
  listBatches,
  listConfirmedMessages,
  readerErrorToResponse,
  resolveReaderUrl,
} from '../../src/lib/reader-client';

const ORIGINAL_FETCH = global.fetch;
const TAG = '0x' + 'aa'.repeat(32);
const TX = '0x' + '01'.repeat(32);

describe('resolveReaderUrl', () => {
  beforeEach(() => {
    delete process.env.READER_URL;
  });

  it('reads from env', () => {
    process.env.READER_URL = 'http://127.0.0.1:8788';
    expect(resolveReaderUrl()).toBe('http://127.0.0.1:8788');
  });

  it('strips trailing slashes', () => {
    process.env.READER_URL = 'http://x/';
    expect(resolveReaderUrl()).toBe('http://x');
  });

  it('throws ReaderConfigError when env is absent', () => {
    expect(() => resolveReaderUrl()).toThrow(ReaderConfigError);
  });

  it('accepts an override argument', () => {
    expect(resolveReaderUrl('http://override')).toBe('http://override');
  });
});

describe('reader-client — URL construction', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
  });

  it('listConfirmedMessages encodes contentTag, status, and limit', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ messages: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    await listConfirmedMessages({
      contentTag: TAG,
      status: 'confirmed',
      limit: 25,
      envUrl: 'http://r',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    const u = new URL(url as string);
    expect(u.origin + u.pathname).toBe('http://r/messages');
    expect(u.searchParams.get('contentTag')).toBe(TAG);
    expect(u.searchParams.get('status')).toBe('confirmed');
    expect(u.searchParams.get('limit')).toBe('25');
    expect((init as { method: string }).method).toBe('GET');
  });

  it('listConfirmedMessages encodes batchRef when supplied (per-batch detail view)', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ messages: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    const TX = '0x' + '01'.repeat(32);
    await listConfirmedMessages({
      contentTag: TAG,
      batchRef: TX,
      envUrl: 'http://r',
    });
    const u = new URL(fetchMock.mock.calls[0][0] as string);
    expect(u.pathname).toBe('/messages');
    expect(u.searchParams.get('contentTag')).toBe(TAG);
    expect(u.searchParams.get('batchRef')).toBe(TX);
  });

  it('listBatches omits optional params when not set', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ batches: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    await listBatches({ contentTag: TAG, envUrl: 'http://r' });
    const u = new URL(fetchMock.mock.calls[0][0] as string);
    expect(u.pathname).toBe('/batches');
    expect(u.searchParams.get('contentTag')).toBe(TAG);
    expect(u.searchParams.has('status')).toBe(false);
    expect(u.searchParams.has('limit')).toBe(false);
  });

  it('getBatch encodes the txHash into the path', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ batch: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    await getBatch(TX, { envUrl: 'http://r' });
    const u = new URL(fetchMock.mock.calls[0][0] as string);
    expect(u.pathname).toBe(`/batches/${TX}`);
  });
});

describe('reader-client — error mapping', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
  });

  it('READER_URL missing → ReaderConfigError', async () => {
    delete process.env.READER_URL;
    await expect(
      listConfirmedMessages({ contentTag: TAG })
    ).rejects.toBeInstanceOf(ReaderConfigError);
  });

  it('fetch network failure → ReaderUnreachableError', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(
      listBatches({ contentTag: TAG, envUrl: 'http://nowhere' })
    ).rejects.toBeInstanceOf(ReaderUnreachableError);
  });

  it('timeout → ReaderUnreachableError', async () => {
    fetchMock.mockRejectedValueOnce(
      Object.assign(new Error('aborted'), { name: 'TimeoutError' })
    );
    await expect(
      getBatch(TX, { envUrl: 'http://r' })
    ).rejects.toBeInstanceOf(ReaderUnreachableError);
  });

  it('readerErrorToResponse maps unreachable → 502 with reader_unreachable', async () => {
    const resp = readerErrorToResponse(new ReaderUnreachableError('x'));
    expect(resp).not.toBeNull();
    expect(resp!.status).toBe(502);
    const body = await resp!.json();
    expect(body.error).toBe('reader_unreachable');
  });

  it('readerErrorToResponse maps config error → 500 with reader_url_not_configured', async () => {
    const resp = readerErrorToResponse(new ReaderConfigError('x'));
    expect(resp).not.toBeNull();
    expect(resp!.status).toBe(500);
    const body = await resp!.json();
    expect(body.error).toBe('reader_url_not_configured');
  });

  it('readerErrorToResponse returns null for unrelated errors', () => {
    expect(readerErrorToResponse(new Error('something else'))).toBeNull();
  });
});

describe('reader-client — READER_TIMEOUT_MS env override', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Mock fetch to honor the AbortSignal — when the signal fires we
    // reject with a TimeoutError-shaped error, mirroring what the
    // real fetch does on `AbortSignal.timeout()`.
    fetchMock = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' }));
          });
        })
    );
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
    delete process.env.READER_TIMEOUT_MS;
  });

  it('aborts within READER_TIMEOUT_MS when set, surfacing ReaderUnreachableError', async () => {
    process.env.READER_TIMEOUT_MS = '50';
    const start = Date.now();
    await expect(
      listBatches({ contentTag: TAG, envUrl: 'http://r' })
    ).rejects.toBeInstanceOf(ReaderUnreachableError);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2_000);
  });
});
