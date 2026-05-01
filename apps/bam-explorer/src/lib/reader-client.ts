/**
 * Typed HTTP client for the `bam-reader` service. **Pure browser
 * client now** — every call takes the upstream `baseUrl` explicitly
 * so the caller (the dashboard's React state, sourced from Settings
 * + `NEXT_PUBLIC_DEFAULT_*` build defaults) controls which Reader is
 * being hit. No `process.env` reads here.
 *
 * Read-only: only the four endpoints Explorer surfaces are exposed.
 */

export class ReaderUnreachableError extends Error {
  readonly reason = 'reader_unreachable';
  constructor(message: string) {
    super(message);
  }
}

export class ReaderConfigError extends Error {
  readonly reason = 'reader_url_not_configured';
}

export interface ReaderClientConfig {
  /**
   * Reader base URL. May include a trailing slash (stripped). An
   * empty string causes every call to throw `ReaderConfigError`.
   */
  baseUrl: string;
  /** Per-call abort signal. */
  signal?: AbortSignal;
  /** Per-call timeout override. Defaults to 8 000 ms. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 8_000;

function resolveBase(raw: string): string {
  if (!raw || raw.length === 0) {
    throw new ReaderConfigError('Reader URL not configured');
  }
  return raw.replace(/\/$/, '');
}

export interface ReaderResponse {
  status: number;
  body: unknown;
  contentType: string;
}

async function rawFetch(
  cfg: ReaderClientConfig,
  path: string
): Promise<ReaderResponse> {
  const base = resolveBase(cfg.baseUrl);
  const url = `${base}${path}`;
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = cfg.signal ? AbortSignal.any([cfg.signal, timeoutSignal]) : timeoutSignal;
  let res: Response;
  try {
    res = await fetch(url, { method: 'GET', signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new ReaderUnreachableError(`reader did not respond within ${timeoutMs}ms`);
    }
    throw new ReaderUnreachableError(err instanceof Error ? err.message : 'unreachable');
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

export async function getHealth(cfg: ReaderClientConfig): Promise<ReaderResponse> {
  return rawFetch(cfg, '/health');
}

export interface ListMessagesArgs {
  contentTag: string;
  status?: 'pending' | 'submitted' | 'confirmed' | 'reorged';
  limit?: number;
  batchRef?: string;
}

export async function listConfirmedMessages(
  cfg: ReaderClientConfig,
  args: ListMessagesArgs
): Promise<ReaderResponse> {
  const q = new URLSearchParams();
  q.set('contentTag', args.contentTag);
  if (args.status !== undefined) q.set('status', args.status);
  if (args.limit !== undefined) q.set('limit', String(args.limit));
  if (args.batchRef !== undefined) q.set('batchRef', args.batchRef);
  return rawFetch(cfg, `/messages?${q.toString()}`);
}

export interface ListBatchesArgs {
  contentTag: string;
  status?: 'pending_tx' | 'confirmed' | 'reorged';
  limit?: number;
}

export async function listBatches(
  cfg: ReaderClientConfig,
  args: ListBatchesArgs
): Promise<ReaderResponse> {
  const q = new URLSearchParams();
  q.set('contentTag', args.contentTag);
  if (args.status !== undefined) q.set('status', args.status);
  if (args.limit !== undefined) q.set('limit', String(args.limit));
  return rawFetch(cfg, `/batches?${q.toString()}`);
}

export async function getBatch(
  cfg: ReaderClientConfig,
  txHash: string
): Promise<ReaderResponse> {
  return rawFetch(cfg, `/batches/${encodeURIComponent(txHash)}`);
}
