/**
 * Typed HTTP client for the `bam-reader` service. Trimmed copy of the
 * client used by the other demo apps — only the endpoints the
 * Explorer reads (health, batches list, messages list, batch by tx
 * hash) are kept. Same env-var contract (`READER_URL`,
 * `READER_TIMEOUT_MS`), same error vocabulary, so an operator who
 * knows the other demos already knows this one.
 *
 * The Explorer is server-rendered: this module is consumed directly
 * by server components, not via a Next.js API route. As a result,
 * `readerErrorToResponse` (used by the proxy-route demos) is
 * intentionally omitted.
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

export async function getHealth(
  args: { envUrl?: string; signal?: AbortSignal } = {}
): Promise<ReaderResponse> {
  return rawFetch('/health', { envUrl: args.envUrl, signal: args.signal });
}

export interface ListMessagesArgs {
  contentTag: string;
  status?: 'pending' | 'submitted' | 'confirmed' | 'reorged';
  limit?: number;
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
