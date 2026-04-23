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

export class PosterUnreachableError extends Error {
  readonly reason = 'poster_unreachable';
  constructor(message: string) {
    super(message);
  }
}

export class PosterConfigError extends Error {
  readonly reason = 'poster_url_not_configured';
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

async function rawFetch(
  method: 'GET' | 'POST',
  path: string,
  init?: { body?: BodyInit; envUrl?: string; signal?: AbortSignal }
): Promise<PosterResponse> {
  const base = resolvePosterUrl(init?.envUrl);
  const url = `${base}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      body: init?.body,
      signal: init?.signal,
    });
  } catch (err) {
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

export async function flush(args: { contentTag: string; envUrl?: string }): Promise<PosterResponse> {
  return rawFetch('POST', `/flush?contentTag=${encodeURIComponent(args.contentTag)}`, {
    envUrl: args.envUrl,
  });
}

export { resolvePosterUrl };
