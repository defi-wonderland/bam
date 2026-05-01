/**
 * Per-panel fetchers. Each one wraps a single Reader or Poster
 * endpoint, returns `PanelResult<T>`, and **never throws** — the
 * dashboard renderer relies on this so a Reader outage doesn't
 * cascade into a 500 page (gate G-6 / partial offline posture).
 *
 * `fetchedAt` is captured per call. The dashboard renderer also
 * stamps a single page-level `fetchedAt` for the header freshness
 * indicator; per-panel timestamps are kept here so future per-panel
 * refresh (deferred) can reuse the same shape without an interface
 * change.
 */

import type { Bytes32 } from 'bam-sdk';

import {
  posterErrorToPanelResult,
  readerErrorToPanelResult,
  type PanelResult,
} from './panel-result';
import * as posterClient from './poster-client';
import * as readerClient from './reader-client';

function reraiseToError<T>(
  err: unknown,
  fetchedAt: number,
  mapper: (e: unknown, t: number) => PanelResult<T> | null
): PanelResult<T> {
  const mapped = mapper(err, fetchedAt);
  if (mapped !== null) return mapped;
  // Anything other than the typed config / unreachable errors is
  // unexpected — render as `error` with a stable shape rather than
  // letting it bubble. The detail string is short and not echoed
  // verbatim from upstream.
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

export async function fetchReaderHealth(): Promise<PanelResult<unknown>> {
  const fetchedAt = Date.now();
  try {
    const res = await readerClient.getHealth();
    return fromHttpResponse(res, fetchedAt);
  } catch (err) {
    return reraiseToError(err, fetchedAt, readerErrorToPanelResult);
  }
}

export async function fetchReaderBatches(
  contentTag: Bytes32,
  limit: number
): Promise<PanelResult<unknown>> {
  const fetchedAt = Date.now();
  try {
    const res = await readerClient.listBatches({ contentTag, limit });
    return fromHttpResponse(res, fetchedAt);
  } catch (err) {
    return reraiseToError(err, fetchedAt, readerErrorToPanelResult);
  }
}

export async function fetchReaderMessages(
  contentTag: Bytes32,
  limit: number
): Promise<PanelResult<unknown>> {
  const fetchedAt = Date.now();
  try {
    const res = await readerClient.listConfirmedMessages({ contentTag, limit });
    return fromHttpResponse(res, fetchedAt);
  } catch (err) {
    return reraiseToError(err, fetchedAt, readerErrorToPanelResult);
  }
}

export async function fetchReaderBatchByTxHash(
  txHash: string
): Promise<PanelResult<unknown> | { kind: 'not_found'; fetchedAt: number }> {
  const fetchedAt = Date.now();
  try {
    const res = await readerClient.getBatch(txHash);
    if (res.status === 404) return { kind: 'not_found', fetchedAt };
    return fromHttpResponse(res, fetchedAt);
  } catch (err) {
    return reraiseToError(err, fetchedAt, readerErrorToPanelResult);
  }
}

// Poster ---------------------------------------------------------------

export async function fetchPosterHealth(): Promise<PanelResult<unknown>> {
  const fetchedAt = Date.now();
  try {
    const res = await posterClient.getHealth();
    return fromHttpResponse(res, fetchedAt);
  } catch (err) {
    return reraiseToError(err, fetchedAt, posterErrorToPanelResult);
  }
}

export async function fetchPosterStatus(): Promise<PanelResult<unknown>> {
  const fetchedAt = Date.now();
  try {
    const res = await posterClient.getStatus();
    return fromHttpResponse(res, fetchedAt);
  } catch (err) {
    return reraiseToError(err, fetchedAt, posterErrorToPanelResult);
  }
}

export async function fetchPosterPending(
  limit: number
): Promise<PanelResult<unknown>> {
  const fetchedAt = Date.now();
  try {
    const res = await posterClient.getPending({ limit });
    return fromHttpResponse(res, fetchedAt);
  } catch (err) {
    return reraiseToError(err, fetchedAt, posterErrorToPanelResult);
  }
}

export async function fetchPosterSubmittedBatches(
  limit: number
): Promise<PanelResult<unknown>> {
  const fetchedAt = Date.now();
  try {
    const res = await posterClient.getSubmittedBatches({ limit });
    return fromHttpResponse(res, fetchedAt);
  } catch (err) {
    return reraiseToError(err, fetchedAt, posterErrorToPanelResult);
  }
}
