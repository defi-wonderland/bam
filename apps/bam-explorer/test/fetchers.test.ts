import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Bytes32 } from 'bam-sdk';

import {
  fetchPosterHealth,
  fetchPosterPending,
  fetchPosterStatus,
  fetchPosterSubmittedBatches,
  fetchReaderBatchByTxHash,
  fetchReaderBatches,
  fetchReaderHealth,
  fetchReaderMessages,
} from '../src/lib/fetchers';
import * as posterClient from '../src/lib/poster-client';
import * as readerClient from '../src/lib/reader-client';
import {
  PosterConfigError,
  PosterUnreachableError,
} from '../src/lib/poster-client';
import {
  ReaderConfigError,
  ReaderUnreachableError,
} from '../src/lib/reader-client';

const TAG = ('0x' + 'aa'.repeat(32)) as Bytes32;
const TX_HASH = '0x' + 'cc'.repeat(32);
const READER_CFG = { baseUrl: 'http://reader.test' };
const POSTER_CFG = { baseUrl: 'http://poster.test' };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Reader fetchers — happy path', () => {
  it('fetchReaderHealth returns ok on 200', async () => {
    vi.spyOn(readerClient, 'getHealth').mockResolvedValue({
      status: 200,
      body: { ok: true },
      contentType: 'application/json',
    });
    const r = await fetchReaderHealth(READER_CFG);
    expect(r.kind).toBe('ok');
  });

  it('fetchReaderBatches returns ok on 200', async () => {
    vi.spyOn(readerClient, 'listBatches').mockResolvedValue({
      status: 200,
      body: { batches: [] },
      contentType: 'application/json',
    });
    const r = await fetchReaderBatches(READER_CFG, TAG, 50);
    expect(r.kind).toBe('ok');
  });

  it('fetchReaderMessages returns ok on 200', async () => {
    vi.spyOn(readerClient, 'listConfirmedMessages').mockResolvedValue({
      status: 200,
      body: { messages: [] },
      contentType: 'application/json',
    });
    const r = await fetchReaderMessages(READER_CFG, TAG, 50);
    expect(r.kind).toBe('ok');
  });
});

describe('Reader fetchers — error paths', () => {
  it('non-2xx → error variant with upstream status', async () => {
    vi.spyOn(readerClient, 'getHealth').mockResolvedValue({
      status: 500,
      body: { error: 'internal_error' },
      contentType: 'application/json',
    });
    const r = await fetchReaderHealth(READER_CFG);
    expect(r).toMatchObject({ kind: 'error', status: 500, detail: 'internal_error' });
  });

  it('ReaderUnreachableError → unreachable variant', async () => {
    vi.spyOn(readerClient, 'getHealth').mockRejectedValue(
      new ReaderUnreachableError('connection refused')
    );
    const r = await fetchReaderHealth(READER_CFG);
    expect(r).toMatchObject({ kind: 'unreachable', detail: 'connection refused' });
  });

  it('ReaderConfigError → not_configured variant', async () => {
    vi.spyOn(readerClient, 'getHealth').mockRejectedValue(
      new ReaderConfigError('Reader URL not configured')
    );
    const r = await fetchReaderHealth(READER_CFG);
    expect(r).toMatchObject({
      kind: 'not_configured',
      reason: 'reader_url_not_configured',
    });
  });

  it('unexpected throw is caught into error variant', async () => {
    vi.spyOn(readerClient, 'listBatches').mockRejectedValue(new Error('boom'));
    const r = await fetchReaderBatches(READER_CFG, TAG, 50);
    expect(r.kind).toBe('error');
  });

  it('empty baseUrl → not_configured (real client error)', async () => {
    const r = await fetchReaderHealth({ baseUrl: '' });
    expect(r.kind).toBe('not_configured');
  });
});

describe('Reader batch-by-tx-hash', () => {
  it('200 → ok', async () => {
    vi.spyOn(readerClient, 'getBatch').mockResolvedValue({
      status: 200,
      body: { batch: { txHash: TX_HASH } },
      contentType: 'application/json',
    });
    const r = await fetchReaderBatchByTxHash(READER_CFG, TX_HASH);
    expect(r.kind).toBe('ok');
  });

  it('404 → not_found', async () => {
    vi.spyOn(readerClient, 'getBatch').mockResolvedValue({
      status: 404,
      body: { error: 'not_found' },
      contentType: 'application/json',
    });
    const r = await fetchReaderBatchByTxHash(READER_CFG, TX_HASH);
    expect(r.kind).toBe('not_found');
  });

  it('unreachable maps through', async () => {
    vi.spyOn(readerClient, 'getBatch').mockRejectedValue(
      new ReaderUnreachableError('down')
    );
    const r = await fetchReaderBatchByTxHash(READER_CFG, TX_HASH);
    expect(r.kind).toBe('unreachable');
  });
});

describe('Poster fetchers — happy path', () => {
  it('fetchPosterHealth returns ok', async () => {
    vi.spyOn(posterClient, 'getHealth').mockResolvedValue({
      status: 200,
      body: { health: { state: 'ok' } },
      contentType: 'application/json',
    });
    const r = await fetchPosterHealth(POSTER_CFG);
    expect(r.kind).toBe('ok');
  });

  it('fetchPosterStatus returns ok', async () => {
    vi.spyOn(posterClient, 'getStatus').mockResolvedValue({
      status: 200,
      body: { status: { foo: 'bar' } },
      contentType: 'application/json',
    });
    const r = await fetchPosterStatus(POSTER_CFG);
    expect(r.kind).toBe('ok');
  });

  it('fetchPosterPending returns ok', async () => {
    vi.spyOn(posterClient, 'getPending').mockResolvedValue({
      status: 200,
      body: { pending: [] },
      contentType: 'application/json',
    });
    const r = await fetchPosterPending(POSTER_CFG, 50);
    expect(r.kind).toBe('ok');
  });

  it('fetchPosterSubmittedBatches returns ok', async () => {
    vi.spyOn(posterClient, 'getSubmittedBatches').mockResolvedValue({
      status: 200,
      body: { batches: [] },
      contentType: 'application/json',
    });
    const r = await fetchPosterSubmittedBatches(POSTER_CFG, 50);
    expect(r.kind).toBe('ok');
  });

  it('forwards authToken through to the client', async () => {
    const spy = vi.spyOn(posterClient, 'getStatus').mockResolvedValue({
      status: 200,
      body: { status: {} },
      contentType: 'application/json',
    });
    await fetchPosterStatus({ baseUrl: 'http://x', authToken: 'tok' });
    expect(spy).toHaveBeenCalledWith({ baseUrl: 'http://x', authToken: 'tok' });
  });
});

describe('Poster fetchers — error paths', () => {
  it('PosterUnreachableError → unreachable variant', async () => {
    vi.spyOn(posterClient, 'getStatus').mockRejectedValue(new PosterUnreachableError('timeout'));
    const r = await fetchPosterStatus(POSTER_CFG);
    expect(r.kind).toBe('unreachable');
  });

  it('PosterConfigError → not_configured variant', async () => {
    vi.spyOn(posterClient, 'getStatus').mockRejectedValue(
      new PosterConfigError('Poster URL not configured')
    );
    const r = await fetchPosterStatus(POSTER_CFG);
    expect(r).toMatchObject({
      kind: 'not_configured',
      reason: 'poster_url_not_configured',
    });
  });

  it('non-2xx → error variant with upstream status', async () => {
    vi.spyOn(posterClient, 'getHealth').mockResolvedValue({
      status: 503,
      body: { error: 'unhealthy' },
      contentType: 'application/json',
    });
    const r = await fetchPosterHealth(POSTER_CFG);
    expect(r).toMatchObject({ kind: 'error', status: 503 });
  });
});
