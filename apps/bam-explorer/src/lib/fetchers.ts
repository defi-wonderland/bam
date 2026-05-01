/**
 * Per-panel fetchers. Each one wraps a single Reader or Poster
 * endpoint, returns `PanelResult<T>`, and **never throws** — the
 * dashboard renderer relies on this so a Reader outage doesn't
 * cascade into a render error (gate G-6 / partial offline posture).
 *
 * `fetchedAt` is captured per call.
 */

import type { Bytes32 } from 'bam-sdk';

import {
  posterErrorToPanelResult,
  readerErrorToPanelResult,
  type PanelResult,
} from './panel-result';
import * as posterClient from './poster-client';
import * as readerClient from './reader-client';

export interface ReaderFetchConfig {
  baseUrl: string;
}

export interface PosterFetchConfig {
  baseUrl: string;
  authToken?: string;
}

function reraiseToError<T>(
  err: unknown,
  fetchedAt: number,
  mapper: (e: unknown, t: number) => PanelResult<T> | null
): PanelResult<T> {
  const mapped = mapper(err, fetchedAt);
  if (mapped !== null) return mapped;
  const detail = err instanceof Error ? err.message : 'unknown error';
  return { kind: 'error', status: 0, detail, fetchedAt };
}

function fromHttpResponse<T>(
  res: { status: number; body: unknown },
  fetchedAt: number
): PanelResult<T> {
  if (res.status >= 200 && res.status < 300) {
    return { kind: 'ok', data: res.body as T, fetchedAt };
  }
  const detail =
    typeof res.body === 'object' && res.body !== null && 'error' in res.body
      ? String((res.body as { error: unknown }).error)
      : undefined;
  return { kind: 'error', status: res.status, detail, fetchedAt };
}

// Reader ---------------------------------------------------------------

export async function fetchReaderHealth(
  cfg: ReaderFetchConfig
): Promise<PanelResult<unknown>> {
  const fetchedAt = Date.now();
  try {
    const res = await readerClient.getHealth({ baseUrl: cfg.baseUrl });
    return fromHttpResponse(res, fetchedAt);
  } catch (err) {
    return reraiseToError(err, fetchedAt, readerErrorToPanelResult);
  }
}

export async function fetchReaderBatches(
  cfg: ReaderFetchConfig,
  contentTag: Bytes32,
  limit: number
): Promise<PanelResult<unknown>> {
  const fetchedAt = Date.now();
  try {
    const res = await readerClient.listBatches({ baseUrl: cfg.baseUrl }, { contentTag, limit });
    return fromHttpResponse(res, fetchedAt);
  } catch (err) {
    return reraiseToError(err, fetchedAt, readerErrorToPanelResult);
  }
}

export async function fetchReaderMessages(
  cfg: ReaderFetchConfig,
  contentTag: Bytes32,
  limit: number
): Promise<PanelResult<unknown>> {
  const fetchedAt = Date.now();
  try {
    const res = await readerClient.listConfirmedMessages(
      { baseUrl: cfg.baseUrl },
      { contentTag, limit }
    );
    return fromHttpResponse(res, fetchedAt);
  } catch (err) {
    return reraiseToError(err, fetchedAt, readerErrorToPanelResult);
  }
}

export async function fetchReaderBatchByTxHash(
  cfg: ReaderFetchConfig,
  txHash: string
): Promise<PanelResult<unknown> | { kind: 'not_found'; fetchedAt: number }> {
  const fetchedAt = Date.now();
  try {
    const res = await readerClient.getBatch({ baseUrl: cfg.baseUrl }, txHash);
    if (res.status === 404) return { kind: 'not_found', fetchedAt };
    return fromHttpResponse(res, fetchedAt);
  } catch (err) {
    return reraiseToError(err, fetchedAt, readerErrorToPanelResult);
  }
}

// Poster ---------------------------------------------------------------

export async function fetchPosterHealth(
  cfg: PosterFetchConfig
): Promise<PanelResult<unknown>> {
  const fetchedAt = Date.now();
  try {
    const res = await posterClient.getHealth(cfg);
    return fromHttpResponse(res, fetchedAt);
  } catch (err) {
    return reraiseToError(err, fetchedAt, posterErrorToPanelResult);
  }
}

export async function fetchPosterStatus(
  cfg: PosterFetchConfig
): Promise<PanelResult<unknown>> {
  const fetchedAt = Date.now();
  try {
    const res = await posterClient.getStatus(cfg);
    return fromHttpResponse(res, fetchedAt);
  } catch (err) {
    return reraiseToError(err, fetchedAt, posterErrorToPanelResult);
  }
}

export async function fetchPosterPending(
  cfg: PosterFetchConfig,
  limit: number
): Promise<PanelResult<unknown>> {
  const fetchedAt = Date.now();
  try {
    const res = await posterClient.getPending(cfg, { limit });
    return fromHttpResponse(res, fetchedAt);
  } catch (err) {
    return reraiseToError(err, fetchedAt, posterErrorToPanelResult);
  }
}

export async function fetchPosterSubmittedBatches(
  cfg: PosterFetchConfig,
  limit: number
): Promise<PanelResult<unknown>> {
  const fetchedAt = Date.now();
  try {
    const res = await posterClient.getSubmittedBatches(cfg, { limit });
    return fromHttpResponse(res, fetchedAt);
  } catch (err) {
    return reraiseToError(err, fetchedAt, posterErrorToPanelResult);
  }
}
