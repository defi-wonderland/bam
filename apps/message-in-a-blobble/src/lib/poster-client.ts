/**
 * Typed HTTP client for the `@bam/poster` service. The demo's Next.js
 * API routes are thin proxies that call this client; the Poster's
 * response (status + body) is returned verbatim to the caller.
 *
 * When `POSTER_URL` is not configured or the Poster is unreachable,
 * `request` surfaces a distinct `unreachable` outcome so the calling
 * route can return a stable 502 with a documented reason rather than
 * leaking a fetch error.
 */

import { NextResponse } from 'next/server';

export class PosterUnreachableError extends Error {
  readonly reason = 'poster_unreachable';
  constructor(message: string) {
    super(message);
  }
}

export class PosterConfigError extends Error {
  readonly reason = 'poster_url_not_configured';
}

/**
 * Shared error-to-NextResponse mapper so every proxy route translates
 * the same two library errors to the same stable wire shape (502 for
 * unreachable, 500 with `poster_misconfigured` for missing POSTER_URL).
 * Returns `null` for anything else; route handlers rethrow so Next's
 * default 500 path kicks in.
 */
export function posterErrorToResponse(err: unknown): NextResponse | null {
  if (err instanceof PosterUnreachableError) {
    return NextResponse.json(
      { error: 'poster_unreachable', detail: 'POSTER_URL not reachable' },
      { status: 502 }
    );
  }
  if (err instanceof PosterConfigError) {
    return NextResponse.json(
      { error: 'poster_url_not_configured', detail: 'POSTER_URL env not set' },
      { status: 500 }
    );
  }
  return null;
}

function resolvePosterUrl(envOverride?: string): string {
  const url = envOverride ?? process.env.POSTER_URL;
  if (!url || url.length === 0) {
    throw new PosterConfigError('POSTER_URL env is required');
  }
  return url.replace(/\/$/, '');
}

export interface PosterResponse {
  status: number;
  body: unknown;
  contentType: string;
}

/**
 * Default request timeout for proxying to the Poster. The Poster's
 * own surfaces are cheap (SQLite/Postgres reads + /health), so a
 * connection that accepts but stalls is almost certainly a sign the
 * Poster is wedged — failing fast beats pinning a Next.js route
 * handler (and its platform-level timeout) waiting.
 */
const DEFAULT_POSTER_TIMEOUT_MS = 8_000;

async function rawFetch(
  method: 'GET' | 'POST',
  path: string,
  init?: { body?: BodyInit; envUrl?: string; signal?: AbortSignal; timeoutMs?: number }
): Promise<PosterResponse> {
  const base = resolvePosterUrl(init?.envUrl);
  const url = `${base}${path}`;
  // Compose caller's AbortSignal with a timeout signal so a slow Poster
  // doesn't hold the route handler open indefinitely. `AbortSignal.any`
  // + `AbortSignal.timeout` are supported in every runtime the demo
  // targets (Node ≥ 20, modern browsers).
  const timeoutMs = init?.timeoutMs ?? DEFAULT_POSTER_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = init?.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal;
  // Forward the operator's bearer token when POSTER_AUTH_TOKEN is set
  // on the demo process (must match the token the Poster is running
  // with). Without this, enabling auth on the Poster 401s every demo
  // proxy call (qodo review).
  const headers: Record<string, string> = {};
  const token = process.env.POSTER_AUTH_TOKEN;
  if (token && token.length > 0) {
    headers.Authorization = `Bearer ${token}`;
  }
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      body: init?.body,
      headers,
      signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new PosterUnreachableError(
        `poster did not respond within ${timeoutMs}ms`
      );
    }
    throw new PosterUnreachableError(
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

export interface SubmitArgs {
  rawEnvelope: Uint8Array;
  hintContentTag?: string;
  envUrl?: string;
}

export async function submitMessage(args: SubmitArgs): Promise<PosterResponse> {
  const query = args.hintContentTag ? `?contentTag=${encodeURIComponent(args.hintContentTag)}` : '';
  return rawFetch('POST', `/submit${query}`, {
    body: new Uint8Array(args.rawEnvelope),
    envUrl: args.envUrl,
  });
}

export async function getPending(args: {
  contentTag?: string;
  limit?: number;
  envUrl?: string;
} = {}): Promise<PosterResponse> {
  const q = new URLSearchParams();
  if (args.contentTag !== undefined) q.set('contentTag', args.contentTag);
  if (args.limit !== undefined) q.set('limit', String(args.limit));
  const qs = q.toString();
  return rawFetch('GET', `/pending${qs ? '?' + qs : ''}`, { envUrl: args.envUrl });
}

export async function getSubmittedBatches(args: {
  contentTag?: string;
  limit?: number;
  sinceBlock?: string;
  envUrl?: string;
} = {}): Promise<PosterResponse> {
  const q = new URLSearchParams();
  if (args.contentTag !== undefined) q.set('contentTag', args.contentTag);
  if (args.limit !== undefined) q.set('limit', String(args.limit));
  if (args.sinceBlock !== undefined) q.set('sinceBlock', args.sinceBlock);
  const qs = q.toString();
  return rawFetch('GET', `/submitted-batches${qs ? '?' + qs : ''}`, {
    envUrl: args.envUrl,
  });
}

export async function getStatus(args: { envUrl?: string } = {}): Promise<PosterResponse> {
  return rawFetch('GET', '/status', { envUrl: args.envUrl });
}

export async function getHealth(args: { envUrl?: string } = {}): Promise<PosterResponse> {
  return rawFetch('GET', '/health', { envUrl: args.envUrl });
}

/**
 * `GET /nonce/<sender>`. The sender is path-encoded so any unexpected
 * characters become a 400 from the Poster rather than a path-traversal
 * surprise. Caller is responsible for parsing `body.nextNonce` (a
 * decimal string) — `rawFetch` does not coerce.
 */
export async function getNextNonce(args: {
  sender: string;
  envUrl?: string;
}): Promise<PosterResponse> {
  return rawFetch('GET', `/nonce/${encodeURIComponent(args.sender)}`, {
    envUrl: args.envUrl,
  });
}

export async function flush(args: { contentTag: string; envUrl?: string }): Promise<PosterResponse> {
  return rawFetch('POST', `/flush?contentTag=${encodeURIComponent(args.contentTag)}`, {
    envUrl: args.envUrl,
  });
}

export { resolvePosterUrl };
