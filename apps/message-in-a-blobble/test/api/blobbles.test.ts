import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MESSAGE_IN_A_BLOBBLE_TAG } from '@/lib/constants';

const ORIGINAL_FETCH = global.fetch;

const TX_A = '0x' + '01'.repeat(32);
const TX_B = '0x' + '02'.repeat(32);
const VH_A = '0x01' + 'aa'.repeat(31);
const VH_B = '0x01' + 'bb'.repeat(31);

function readerBatch(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    txHash: TX_A,
    chainId: 11155111,
    contentTag: MESSAGE_IN_A_BLOBBLE_TAG,
    blobVersionedHash: VH_A,
    batchContentHash: '0x' + 'ee'.repeat(32),
    blockNumber: 100,
    txIndex: 0,
    status: 'confirmed',
    replacedByTxHash: null,
    submittedAt: 1_700_000_000_000,
    invalidatedAt: null,
    messageSnapshot: [],
    ...over,
  };
}

describe('GET /api/blobbles — Reader proxy', () => {
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

  it('forwards to the Reader and reshapes BatchRow[] → Blobble[]', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          batches: [
            readerBatch({ txHash: TX_A, blockNumber: 100 }),
            readerBatch({ txHash: TX_B, blockNumber: 200, blobVersionedHash: VH_B }),
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      )
    );
    const { GET } = await import('../../src/app/api/blobbles/route');
    const res = await GET();
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.pathname).toBe('/batches');
    expect(url.searchParams.get('contentTag')).toBe(MESSAGE_IN_A_BLOBBLE_TAG);
    expect(url.searchParams.get('status')).toBe('confirmed');
    const body = (await res.json()) as { blobbles: Array<Record<string, unknown>> };
    // Sorted desc by blockNumber.
    expect(body.blobbles.map((b) => b.txHash)).toEqual([TX_B, TX_A]);
    const first = body.blobbles[0];
    expect(first.versionedHash).toBe(VH_B);
    expect(first.blockNumber).toBe(200);
    expect(typeof first.timestamp).toBe('number');
    expect(first.timestamp).toBe(Math.floor(1_700_000_000_000 / 1000));
  });

  it('returns 502 reader_unreachable when fetch fails', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    const { GET } = await import('../../src/app/api/blobbles/route');
    const res = await GET();
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('reader_unreachable');
  });

  it('returns 500 reader_url_not_configured when READER_URL is missing', async () => {
    delete process.env.READER_URL;
    const { GET } = await import('../../src/app/api/blobbles/route');
    const res = await GET();
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('reader_url_not_configured');
  });
});
