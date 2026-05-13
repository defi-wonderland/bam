/**
 * Typed HTTP client for the `bam-indexer` service. Mirrors
 * `reader-client.ts` shape (timeout, unreachable / config errors,
 * stable error wire). The Twitter feed prefers the indexer when
 * `INDEXER_URL` is set — it returns app-shaped rows with payloads
 * pre-decoded and ENS resolved — and falls back to the Reader proxy
 * when the indexer is unreachable or unconfigured.
 */

import { NextResponse } from 'next/server';

export class IndexerUnreachableError extends Error {
  readonly reason = 'indexer_unreachable';
  constructor(message: string) {
    super(message);
  }
}

export class IndexerConfigError extends Error {
  readonly reason = 'indexer_url_not_configured';
}

export function indexerErrorToResponse(err: unknown): NextResponse | null {
  if (err instanceof IndexerUnreachableError) {
    return NextResponse.json(
      { error: 'indexer_unreachable', detail: 'INDEXER_URL not reachable' },
      { status: 502 }
    );
  }
  if (err instanceof IndexerConfigError) {
    return NextResponse.json(
      { error: 'indexer_url_not_configured', detail: 'INDEXER_URL env not set' },
      { status: 500 }
    );
  }
  return null;
}

export function resolveIndexerUrl(envOverride?: string): string {
  const url = envOverride ?? process.env.INDEXER_URL;
  if (!url || url.length === 0) {
    throw new IndexerConfigError('INDEXER_URL env is required');
  }
  return url.replace(/\/$/, '');
}

export function indexerUrlIfConfigured(envOverride?: string): string | null {
  const url = envOverride ?? process.env.INDEXER_URL;
  if (!url || url.length === 0) return null;
  return url.replace(/\/$/, '');
}

export interface IndexerResponse {
  status: number;
  body: unknown;
  contentType: string;
}

const DEFAULT_INDEXER_TIMEOUT_MS = 8_000;

function resolveTimeoutMs(): number {
  const raw = process.env.INDEXER_TIMEOUT_MS;
  if (raw === undefined || raw === '') return DEFAULT_INDEXER_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_INDEXER_TIMEOUT_MS;
  return n;
}

async function rawFetch(
  path: string,
  init?: { envUrl?: string; signal?: AbortSignal; timeoutMs?: number }
): Promise<IndexerResponse> {
  const base = resolveIndexerUrl(init?.envUrl);
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
      throw new IndexerUnreachableError(
        `indexer did not respond within ${timeoutMs}ms`
      );
    }
    throw new IndexerUnreachableError(
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

export interface TwitterPostRow {
  message_id: string;
  message_hash: string;
  sender: string;
  nonce: string;
  kind: 'post' | 'reply';
  timestamp: number;
  content: string;
  parent_message_hash: string | null;
  batch_ref: string;
  block_number: number;
  tx_index: number;
  message_index_within_batch: number;
  sender_ens: string | null;
}

export interface ListTwitterPostsArgs {
  sender?: string;
  /** Lower-bound on block_number. */
  since?: number;
  limit?: number;
  envUrl?: string;
  signal?: AbortSignal;
}

/**
 * GET /twitter/posts — top-level posts. The indexer's `kind=0`
 * filter is applied server-side; for the global feed we keep
 * paging from the latest block down.
 */
export async function listTwitterPosts(
  args: ListTwitterPostsArgs = {}
): Promise<IndexerResponse> {
  const q = new URLSearchParams();
  if (args.sender !== undefined) q.set('sender', args.sender);
  if (args.since !== undefined) q.set('since', String(args.since));
  if (args.limit !== undefined) q.set('limit', String(args.limit));
  const path = q.toString().length === 0 ? `/twitter/posts` : `/twitter/posts?${q.toString()}`;
  return rawFetch(path, { envUrl: args.envUrl, signal: args.signal });
}

export interface ListTwitterRepliesArgs {
  parentMessageHash: string;
  limit?: number;
  envUrl?: string;
  signal?: AbortSignal;
}

export async function listTwitterReplies(
  args: ListTwitterRepliesArgs
): Promise<IndexerResponse> {
  const q = new URLSearchParams();
  q.set('parentMessageHash', args.parentMessageHash);
  if (args.limit !== undefined) q.set('limit', String(args.limit));
  return rawFetch(`/twitter/replies?${q.toString()}`, {
    envUrl: args.envUrl,
    signal: args.signal,
  });
}

export interface IndexerHealth {
  chainId: number;
  uptimeMs: number;
  handlers: Array<{ name: string; version: number; contentTag: string; schema: string }>;
  cursors: Array<{
    handler: string;
    version: number;
    contentTag: string;
    lastBlockNumber: number | null;
    lastTxIndex: number | null;
    lastMsgIndex: number | null;
    lastReorgInvalidatedAt: number | null;
    updatedAt: number | null;
  }>;
}
