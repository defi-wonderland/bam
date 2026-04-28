import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MESSAGE_IN_A_BLOBBLE_TAG } from '@/lib/constants';
import { encodeSocialContents } from '@/lib/contents-codec';
import type { Bytes32 } from 'bam-sdk/browser';

const ORIGINAL_FETCH = global.fetch;

const TX = '0x' + '01'.repeat(32);
const TX_BAD = '0xnope';
const VH = '0x01' + 'aa'.repeat(31);
const ADDR_A = '0x' + '11'.repeat(20);
const ADDR_B = '0x' + '22'.repeat(20);

function bytesToHex(bytes: Uint8Array): string {
  let out = '0x';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function makeContentsHex(content: string, timestamp = 1_700_000_000): string {
  const bytes = encodeSocialContents(MESSAGE_IN_A_BLOBBLE_TAG as Bytes32, {
    timestamp,
    content,
  });
  return bytesToHex(bytes);
}

function readerBatch(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    txHash: TX,
    chainId: 11155111,
    contentTag: MESSAGE_IN_A_BLOBBLE_TAG,
    blobVersionedHash: VH,
    batchContentHash: '0x' + 'ee'.repeat(32),
    blockNumber: 100,
    txIndex: 0,
    status: 'confirmed',
    replacedByTxHash: null,
    submittedAt: 1_700_000_000_000,
    invalidatedAt: null,
    messageSnapshot: [
      {
        author: ADDR_A,
        nonce: '1',
        messageId: '0x' + '99'.repeat(32),
        messageIndexWithinBatch: 0,
        messageHash: '0x' + '77'.repeat(32),
      },
      {
        author: ADDR_B,
        nonce: '5',
        messageId: '0x' + 'aa'.repeat(32),
        messageIndexWithinBatch: 1,
        messageHash: '0x' + 'bb'.repeat(32),
      },
    ],
    ...over,
  };
}

function readerMessageRow(args: {
  author: string;
  nonce: string;
  contents: string;
}): Record<string, unknown> {
  return {
    messageId: '0x' + '99'.repeat(32),
    author: args.author,
    nonce: args.nonce,
    contentTag: MESSAGE_IN_A_BLOBBLE_TAG,
    contents: args.contents,
    signature: '0x' + '00'.repeat(65),
    messageHash: '0x' + '77'.repeat(32),
    status: 'confirmed',
    batchRef: TX,
    blockNumber: 100,
    txIndex: 0,
    messageIndexWithinBatch: 0,
  };
}

async function callRoute(txHash: string): Promise<Response> {
  const { GET } = await import('../../src/app/api/blobbles/[txHash]/route');
  return GET({} as never, { params: Promise.resolve({ txHash }) });
}

/**
 * Set up the two parallel Reader fetches. The route fires both in
 * `Promise.all`, so we mock them in call order: batch first, then
 * messages.
 */
function mockReaderResponses(
  fetchMock: ReturnType<typeof vi.fn>,
  batch: { status: number; body: unknown },
  messages: { status: number; body: unknown }
): void {
  fetchMock.mockImplementation(async (input: string | URL) => {
    const url = new URL(typeof input === 'string' ? input : input.href);
    if (url.pathname.startsWith('/batches/')) {
      return new Response(JSON.stringify(batch.body), {
        status: batch.status,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.pathname === '/messages') {
      return new Response(JSON.stringify(messages.body), {
        status: messages.status,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch to ${url.pathname}`);
  });
}

describe('GET /api/blobbles/[txHash] — Reader proxy', () => {
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

  it('fans out batch + messages calls and decodes content text', async () => {
    const helloHex = makeContentsHex('hello world', 1_700_000_001);
    const worldHex = makeContentsHex('second message', 1_700_000_002);
    mockReaderResponses(
      fetchMock,
      { status: 200, body: { batch: readerBatch() } },
      {
        status: 200,
        body: {
          messages: [
            readerMessageRow({ author: ADDR_A, nonce: '1', contents: helloHex }),
            readerMessageRow({ author: ADDR_B, nonce: '5', contents: worldHex }),
          ],
        },
      }
    );
    const res = await callRoute(TX);
    expect(res.status).toBe(200);

    // Two parallel reads: /batches/:tx and /messages?batchRef=:tx
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const messagesUrl = new URL(
      fetchMock.mock.calls.find((c) =>
        new URL(c[0] as string).pathname === '/messages'
      )![0] as string
    );
    expect(messagesUrl.searchParams.get('contentTag')).toBe(MESSAGE_IN_A_BLOBBLE_TAG);
    expect(messagesUrl.searchParams.get('batchRef')).toBe(TX);

    const body = (await res.json()) as {
      txHash: string;
      messageCount: number;
      messages: Array<{ sender: string; nonce: string; content: string | null }>;
    };
    expect(body.txHash).toBe(TX);
    expect(body.messageCount).toBe(2);
    expect(body.messages.map((m) => m.content)).toEqual([
      'hello world',
      'second message',
    ]);
    expect(body.messages.map((m) => m.nonce)).toEqual(['1', '5']);
  });

  it('falls back to null content when a snapshot entry has no matching message row', async () => {
    mockReaderResponses(
      fetchMock,
      { status: 200, body: { batch: readerBatch() } },
      { status: 200, body: { messages: [] } }
    );
    const res = await callRoute(TX);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      messages: Array<{ content: string | null }>;
    };
    expect(body.messages.length).toBe(2);
    expect(body.messages.every((m) => m.content === null)).toBe(true);
  });

  it('returns 404 when the Reader has no row for the txHash', async () => {
    mockReaderResponses(
      fetchMock,
      { status: 404, body: { error: 'not_found' } },
      { status: 200, body: { messages: [] } }
    );
    const res = await callRoute(TX);
    expect(res.status).toBe(404);
  });

  it('forwards a 400 from the Reader for a malformed txHash', async () => {
    mockReaderResponses(
      fetchMock,
      { status: 400, body: { error: 'bad_request', reason: 'txHash' } },
      { status: 200, body: { messages: [] } }
    );
    const res = await callRoute(TX_BAD);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('bad_request');
  });

  it('returns 502 reader_unreachable when fetch fails', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const res = await callRoute(TX);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('reader_unreachable');
  });
});
