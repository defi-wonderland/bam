import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MESSAGE_IN_A_BLOBBLE_TAG } from '@/lib/constants';

const ORIGINAL_FETCH = global.fetch;

const TX_HASH = ('0x' + 'aa'.repeat(32)) as const;

function readerMessage(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    messageId: '0x' + '99'.repeat(32),
    author: '0x' + '11'.repeat(20),
    nonce: '1',
    contentTag: MESSAGE_IN_A_BLOBBLE_TAG,
    contents: '0xdeadbeef',
    signature: '0x' + '00'.repeat(65),
    messageHash: '0x' + '77'.repeat(32),
    status: 'confirmed',
    batchRef: TX_HASH,
    blockNumber: 100,
    ...over,
  };
}

describe('GET /api/confirmed-messages — Reader proxy', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.READER_URL = 'http://reader.test';
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
    delete process.env.READER_URL;
    vi.resetModules();
  });

  it('forwards to the Reader and reshapes the response', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          messages: [
            readerMessage({ nonce: '1' }),
            readerMessage({ nonce: '2', author: '0x' + '22'.repeat(20) }),
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      )
    );
    const { GET } = await import('../../src/app/api/confirmed-messages/route');
    const res = await GET();
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.origin + url.pathname).toBe('http://reader.test/messages');
    expect(url.searchParams.get('contentTag')).toBe(MESSAGE_IN_A_BLOBBLE_TAG);
    expect(url.searchParams.get('status')).toBe('confirmed');
    const body = (await res.json()) as { messages: Array<Record<string, unknown>> };
    expect(body.messages.length).toBe(2);
    const r1 = body.messages.find((m) => m.nonce === '1');
    expect(r1).toMatchObject({
      sender: '0x' + '11'.repeat(20),
      nonce: '1',
      contents: '0xdeadbeef',
      tx_hash: TX_HASH,
      block_number: 100,
      blobble_id: TX_HASH.slice(0, 18),
      status: 'posted',
    });
  });

  it('drops rows whose batchRef is null (substrate invariant)', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          messages: [
            readerMessage({ nonce: '1', batchRef: null }),
            readerMessage({ nonce: '2' }),
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      )
    );
    const { GET } = await import('../../src/app/api/confirmed-messages/route');
    const res = await GET();
    const body = (await res.json()) as { messages: Array<{ nonce: string }> };
    expect(body.messages.map((m) => m.nonce)).toEqual(['2']);
  });

  it('forwards an upstream non-200 status verbatim', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'bad_request', reason: 'contentTag' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })
    );
    const { GET } = await import('../../src/app/api/confirmed-messages/route');
    const res = await GET();
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('bad_request');
  });

  it('returns 502 reader_unreachable when fetch fails', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    const { GET } = await import('../../src/app/api/confirmed-messages/route');
    const res = await GET();
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('reader_unreachable');
  });

  it('returns 500 reader_url_not_configured when READER_URL is missing', async () => {
    delete process.env.READER_URL;
    const { GET } = await import('../../src/app/api/confirmed-messages/route');
    const res = await GET();
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('reader_url_not_configured');
  });
});
