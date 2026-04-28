/**
 * Typed HTTP client for the `bam-reader` service. Mirrors
 * `poster-client.ts` so the demo's confirmed-read API routes look
 * identical in shape to its submission proxies — same error wire,
 * same timeout, same env-var contract.
 *
 * When `READER_URL` is missing or the Reader is unreachable, the
 * caller-facing route returns a stable 500 / 502 with a documented
 * `error` code rather than leaking a fetch error. The Reader itself
 * defaults to binding `127.0.0.1:8788`; the demo's default
 * `READER_URL` matches.
 */

import { NextResponse } from 'next/server';

export class ReaderUnreachableError extends Error {
  readonly reason = 'reader_unreachable';
  constructor(message: string) {
    super(message);
  }
}

export class ReaderConfigError extends Error {
  readonly reason = 'reader_url_not_configured';
}

/**
 * Shared error-to-NextResponse mapper so every Reader-proxy route
 * translates the same two library errors to the same wire shape:
 *   - 502 with `{ error: 'reader_unreachable' }`
 *   - 500 with `{ error: 'reader_url_not_configured' }`
 *
 * Returns `null` for anything else; route handlers rethrow so Next's
 * default 500 path kicks in.
 */
export function readerErrorToResponse(err: unknown): NextResponse | null {
  if (err instanceof ReaderUnreachableError) {
    return NextResponse.json(
      { error: 'reader_unreachable', detail: 'READER_URL not reachable' },
      { status: 502 }
    );
  }
  if (err instanceof ReaderConfigError) {
    return NextResponse.json(
      { error: 'reader_url_not_configured', detail: 'READER_URL env not set' },
      { status: 500 }
    );
  }
  return null;
}

export function resolveReaderUrl(envOverride?: string): string {
  const url = envOverride ?? process.env.READER_URL;
  if (!url || url.length === 0) {
    throw new ReaderConfigError('READER_URL env is required');
  }
  return url.replace(/\/$/, '');
}

export interface ReaderResponse {
  status: number;
  body: unknown;
  contentType: string;
}

/**
 * Default request timeout for proxying to the Reader. Matches the
 * Poster client's `DEFAULT_POSTER_TIMEOUT_MS`. The Reader's reads are
 * cheap (a single bam-store query); a connection that accepts but
 * stalls is a sign the Reader is wedged — failing fast keeps the
 * Next.js route handler from holding open beyond its platform-level
 * timeout. Override per-deploy with `READER_TIMEOUT_MS` (parsed at
 * call time so test environments can flip it via `process.env`
 * without re-importing).
 */
const DEFAULT_READER_TIMEOUT_MS = 8_000;

function resolveTimeoutMs(): number {
  const raw = process.env.READER_TIMEOUT_MS;
  if (raw === undefined || raw === '') return DEFAULT_READER_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_READER_TIMEOUT_MS;
  return n;
}

async function rawFetch(
  path: string,
  init?: { envUrl?: string; signal?: AbortSignal; timeoutMs?: number }
): Promise<ReaderResponse> {
  const base = resolveReaderUrl(init?.envUrl);
  const url = `${base}${path}`;
  const timeoutMs = init?.timeoutMs ?? resolveTimeoutMs();
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = init?.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal;
  let res: Response;
  try {
    res = await fetch(url, { method: 'GET', signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new ReaderUnreachableError(
        `reader did not respond within ${timeoutMs}ms`
      );
    }
    throw new ReaderUnreachableError(
      err instanceof Error ? err.message : 'unreachable'
    );
  }
  const contentType = res.headers.get('content-type') ?? 'application/json';
  let body: unknown;
  try {
    body = contentType.includes('application/json') ? await res.json() : await res.text();
  } catch {
    body = null;
  }
  return { status: res.status, body, contentType };
}

export interface ListMessagesArgs {
  contentTag: string;
  status?: 'pending' | 'submitted' | 'confirmed' | 'reorged';
  limit?: number;
  /**
   * Restrict to messages attached to a specific batch (used by the
   * blobble-detail view to fetch the rows that belong to one batch
   * with their full `contents` payload).
   */
  batchRef?: string;
  envUrl?: string;
  signal?: AbortSignal;
}

export async function listConfirmedMessages(
  args: ListMessagesArgs
): Promise<ReaderResponse> {
  const q = new URLSearchParams();
  q.set('contentTag', args.contentTag);
  if (args.status !== undefined) q.set('status', args.status);
  if (args.limit !== undefined) q.set('limit', String(args.limit));
  if (args.batchRef !== undefined) q.set('batchRef', args.batchRef);
  return rawFetch(`/messages?${q.toString()}`, {
    envUrl: args.envUrl,
    signal: args.signal,
  });
}

export interface ListBatchesArgs {
  contentTag: string;
  status?: 'pending_tx' | 'confirmed' | 'reorged';
  limit?: number;
  envUrl?: string;
  signal?: AbortSignal;
}

export async function listBatches(
  args: ListBatchesArgs
): Promise<ReaderResponse> {
  const q = new URLSearchParams();
  q.set('contentTag', args.contentTag);
  if (args.status !== undefined) q.set('status', args.status);
  if (args.limit !== undefined) q.set('limit', String(args.limit));
  return rawFetch(`/batches?${q.toString()}`, {
    envUrl: args.envUrl,
    signal: args.signal,
  });
}

export async function getBatch(
  txHash: string,
  args: { envUrl?: string; signal?: AbortSignal } = {}
): Promise<ReaderResponse> {
  return rawFetch(`/batches/${encodeURIComponent(txHash)}`, {
    envUrl: args.envUrl,
    signal: args.signal,
  });
}
