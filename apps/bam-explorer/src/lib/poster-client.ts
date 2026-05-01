/**
 * Typed HTTP client for the `@bam/poster` service. **Read-only by
 * design** — only the four GET endpoints the Explorer surfaces
 * (`/health`, `/status`, `/pending`, `/submitted-batches`) are
 * exported. The Poster's `POST /submit` and `POST /flush` are
 * deliberately not wired up here so a future contributor cannot
 * trigger a write from inside the Explorer without first
 * re-introducing those exports.
 *
 * Same env-var contract as the other demo apps' Poster client:
 * `POSTER_URL`, `POSTER_AUTH_TOKEN`. Same error vocabulary
 * (`PosterUnreachableError` / `PosterConfigError`). Server-rendered
 * only — no Next.js API route, no `posterErrorToResponse`.
 */

export class PosterUnreachableError extends Error {
  readonly reason = 'poster_unreachable';
  constructor(message: string) {
    super(message);
  }
}

export class PosterConfigError extends Error {
  readonly reason = 'poster_url_not_configured';
}

export function resolvePosterUrl(envOverride?: string): string {
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

const DEFAULT_POSTER_TIMEOUT_MS = 8_000;

async function rawFetch(
  path: string,
  init?: { envUrl?: string; signal?: AbortSignal; timeoutMs?: number }
): Promise<PosterResponse> {
  const base = resolvePosterUrl(init?.envUrl);
  const url = `${base}${path}`;
  const timeoutMs = init?.timeoutMs ?? DEFAULT_POSTER_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = init?.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal;
  const headers: Record<string, string> = {};
  const token = process.env.POSTER_AUTH_TOKEN;
  if (token && token.length > 0) {
    headers.Authorization = `Bearer ${token}`;
  }
  let res: Response;
  try {
    res = await fetch(url, { method: 'GET', headers, signal });
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

export async function getHealth(
  args: { envUrl?: string; signal?: AbortSignal } = {}
): Promise<PosterResponse> {
  return rawFetch('/health', { envUrl: args.envUrl, signal: args.signal });
}

export async function getStatus(
  args: { envUrl?: string; signal?: AbortSignal } = {}
): Promise<PosterResponse> {
  return rawFetch('/status', { envUrl: args.envUrl, signal: args.signal });
}

export async function getPending(
  args: { contentTag?: string; limit?: number; envUrl?: string; signal?: AbortSignal } = {}
): Promise<PosterResponse> {
  const q = new URLSearchParams();
  if (args.contentTag !== undefined) q.set('contentTag', args.contentTag);
  if (args.limit !== undefined) q.set('limit', String(args.limit));
  const qs = q.toString();
  return rawFetch(`/pending${qs ? '?' + qs : ''}`, {
    envUrl: args.envUrl,
    signal: args.signal,
  });
}

export async function getSubmittedBatches(
  args: {
    contentTag?: string;
    limit?: number;
    sinceBlock?: string;
    envUrl?: string;
    signal?: AbortSignal;
  } = {}
): Promise<PosterResponse> {
  const q = new URLSearchParams();
  if (args.contentTag !== undefined) q.set('contentTag', args.contentTag);
  if (args.limit !== undefined) q.set('limit', String(args.limit));
  if (args.sinceBlock !== undefined) q.set('sinceBlock', args.sinceBlock);
  const qs = q.toString();
  return rawFetch(`/submitted-batches${qs ? '?' + qs : ''}`, {
    envUrl: args.envUrl,
    signal: args.signal,
  });
}
