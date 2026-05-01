/**
 * Typed HTTP client for the `@bam/poster` service. **Pure browser
 * client, read-only by design.** Every call takes the upstream
 * `baseUrl` and an optional bearer `authToken` explicitly — both
 * sourced from Settings + `NEXT_PUBLIC_DEFAULT_*` build defaults.
 * The Poster's `POST /submit` and `POST /flush` are deliberately
 * not exported here; a future contributor cannot wire a write
 * surface without first re-introducing those exports.
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

export interface PosterClientConfig {
  /** Poster base URL. Empty string → `PosterConfigError`. */
  baseUrl: string;
  /**
   * Optional bearer token. Forwarded as
   * `Authorization: Bearer <token>` on every call. **Never** sourced
   * from a build-time env: a deployed Explorer doesn't ship an
   * operator's token to anonymous visitors.
   */
  authToken?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 8_000;

function resolveBase(raw: string): string {
  if (!raw || raw.length === 0) {
    throw new PosterConfigError('Poster URL not configured');
  }
  return raw.replace(/\/$/, '');
}

export interface PosterResponse {
  status: number;
  body: unknown;
  contentType: string;
}

async function rawFetch(
  cfg: PosterClientConfig,
  path: string
): Promise<PosterResponse> {
  const base = resolveBase(cfg.baseUrl);
  const url = `${base}${path}`;
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = cfg.signal ? AbortSignal.any([cfg.signal, timeoutSignal]) : timeoutSignal;
  const headers: Record<string, string> = {};
  if (cfg.authToken && cfg.authToken.length > 0) {
    headers.Authorization = `Bearer ${cfg.authToken}`;
  }
  let res: Response;
  try {
    res = await fetch(url, { method: 'GET', headers, signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new PosterUnreachableError(`poster did not respond within ${timeoutMs}ms`);
    }
    throw new PosterUnreachableError(err instanceof Error ? err.message : 'unreachable');
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

export async function getHealth(cfg: PosterClientConfig): Promise<PosterResponse> {
  return rawFetch(cfg, '/health');
}

export async function getStatus(cfg: PosterClientConfig): Promise<PosterResponse> {
  return rawFetch(cfg, '/status');
}

export async function getPending(
  cfg: PosterClientConfig,
  args: { contentTag?: string; limit?: number } = {}
): Promise<PosterResponse> {
  const q = new URLSearchParams();
  if (args.contentTag !== undefined) q.set('contentTag', args.contentTag);
  if (args.limit !== undefined) q.set('limit', String(args.limit));
  const qs = q.toString();
  return rawFetch(cfg, `/pending${qs ? '?' + qs : ''}`);
}

export async function getSubmittedBatches(
  cfg: PosterClientConfig,
  args: { contentTag?: string; limit?: number; sinceBlock?: string } = {}
): Promise<PosterResponse> {
  const q = new URLSearchParams();
  if (args.contentTag !== undefined) q.set('contentTag', args.contentTag);
  if (args.limit !== undefined) q.set('limit', String(args.limit));
  if (args.sinceBlock !== undefined) q.set('sinceBlock', args.sinceBlock);
  const qs = q.toString();
  return rawFetch(cfg, `/submitted-batches${qs ? '?' + qs : ''}`);
}
