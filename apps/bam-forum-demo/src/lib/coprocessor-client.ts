/**
 * Typed HTTP client for the `bam-coprocessor` service. Mirrors
 * `poster-client.ts` / `reader-client.ts` so every API route looks
 * identical: same error wire, same 8-second timeout, same env-var
 * contract.
 *
 * The coprocessor's `GET /validation/latest` returns 503 with body
 * `{"error":"no_validation_yet"}` when no message has been validated
 * yet. That's a normal startup state, not an outage — we map it to
 * `{ items: [] }` so consumers don't need to special-case it.
 */

import { NextResponse } from 'next/server';

export class CoprocessorUnreachableError extends Error {
  readonly reason = 'coprocessor_unreachable';
  constructor(message: string) {
    super(message);
  }
}

export class CoprocessorConfigError extends Error {
  readonly reason = 'coprocessor_url_not_configured';
}

export function coprocessorErrorToResponse(err: unknown): NextResponse | null {
  if (err instanceof CoprocessorUnreachableError) {
    return NextResponse.json(
      { error: 'coprocessor_unreachable', detail: 'COPROCESSOR_URL not reachable' },
      { status: 502 }
    );
  }
  if (err instanceof CoprocessorConfigError) {
    return NextResponse.json(
      { error: 'coprocessor_url_not_configured', detail: 'COPROCESSOR_URL env not set' },
      { status: 500 }
    );
  }
  return null;
}

export function resolveCoprocessorUrl(envOverride?: string): string {
  const url = envOverride ?? process.env.COPROCESSOR_URL;
  if (!url || url.length === 0) {
    throw new CoprocessorConfigError('COPROCESSOR_URL env is required');
  }
  return url.replace(/\/$/, '');
}

const DEFAULT_COPROCESSOR_TIMEOUT_MS = 8_000;

interface RawResponse {
  status: number;
  body: unknown;
}

async function rawFetch(
  path: string,
  init?: { envUrl?: string; signal?: AbortSignal; timeoutMs?: number }
): Promise<RawResponse> {
  const base = resolveCoprocessorUrl(init?.envUrl);
  const url = `${base}${path}`;
  const timeoutMs = init?.timeoutMs ?? DEFAULT_COPROCESSOR_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = init?.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal;
  let res: Response;
  try {
    res = await fetch(url, { method: 'GET', signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new CoprocessorUnreachableError(
        `coprocessor did not respond within ${timeoutMs}ms`
      );
    }
    throw new CoprocessorUnreachableError(
      err instanceof Error ? err.message : 'unreachable'
    );
  }
  const contentType = res.headers.get('content-type') ?? 'application/json';
  let body: unknown = null;
  try {
    body = contentType.includes('application/json') ? await res.json() : await res.text();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

// ── Per-message validation list ─────────────────────────────────────────────

export interface ValidationEntry {
  messageHash: string;
  chainId: number;
  versionedHash: string;
  contentTag: string;
  startFe: number;
  endFe: number;
  blockNumber: number;
  txIndex: number;
  msgIndex: number;
  sender: string;
  nonce: string;
  cycles: number;
  validatedAt: string;
}

export interface ValidationListResponse {
  items: ValidationEntry[];
  next_cursor?: string;
}

/**
 * `GET /validation/latest?limit=&cursor=`. Treats `503 no_validation_yet`
 * (with no cursor) as an empty list — that's the documented "nothing
 * validated yet" signal, not an outage. Any other non-2xx surfaces as
 * `CoprocessorUnreachableError`.
 */
export async function getValidations(args: {
  limit?: number;
  cursor?: string;
  envUrl?: string;
  signal?: AbortSignal;
} = {}): Promise<ValidationListResponse> {
  const q = new URLSearchParams();
  if (args.limit !== undefined) q.set('limit', String(args.limit));
  if (args.cursor !== undefined) q.set('cursor', args.cursor);
  const qs = q.toString();
  const r = await rawFetch(`/validation/latest${qs ? '?' + qs : ''}`, {
    envUrl: args.envUrl,
    signal: args.signal,
  });
  if (r.status === 503 && args.cursor === undefined) {
    return { items: [] };
  }
  if (r.status >= 500) {
    throw new CoprocessorUnreachableError(
      `validation/latest returned ${r.status}`
    );
  }
  if (r.status >= 400 || !isObject(r.body)) {
    return { items: [] };
  }
  return r.body as unknown as ValidationListResponse;
}

// ── Per-message proof list + bundle ─────────────────────────────────────────

export interface ProofSummaryEntry {
  messageHash: string;
  chainId: number;
  versionedHash: string;
  contentTag: string;
  startFe: number;
  endFe: number;
  blockNumber: number;
  txIndex: number;
  msgIndex: number;
  sender: string;
  nonce: string;
  cycles: number;
  proofSize: number;
  proofType: string;
  requestId: string;
  txHash: string | null;
  sp1Version: string;
  provenAt: string;
}

export interface ProofListResponse {
  items: ProofSummaryEntry[];
  next_cursor?: string;
}

export async function getProofs(args: {
  limit?: number;
  cursor?: string;
  envUrl?: string;
  signal?: AbortSignal;
} = {}): Promise<ProofListResponse> {
  const q = new URLSearchParams();
  if (args.limit !== undefined) q.set('limit', String(args.limit));
  if (args.cursor !== undefined) q.set('cursor', args.cursor);
  const qs = q.toString();
  const r = await rawFetch(`/proof${qs ? '?' + qs : ''}`, {
    envUrl: args.envUrl,
    signal: args.signal,
  });
  if (r.status >= 500) {
    throw new CoprocessorUnreachableError(`proof list returned ${r.status}`);
  }
  if (r.status >= 400 || !isObject(r.body)) {
    return { items: [] };
  }
  return r.body as unknown as ProofListResponse;
}

export interface ProofBundleResponse extends ProofSummaryEntry {
  proofBytes: string;
  publicValues: string;
  vkUrl: string;
  batchCount?: number;
}

/** Returns `null` on 404 (no proof for that message). */
export async function getProofByMessageHash(
  messageHash: string,
  args: { envUrl?: string; signal?: AbortSignal } = {}
): Promise<ProofBundleResponse | null> {
  const r = await rawFetch(`/proof/${encodeURIComponent(messageHash)}`, args);
  if (r.status === 404) return null;
  if (r.status >= 500) {
    throw new CoprocessorUnreachableError(`proof get returned ${r.status}`);
  }
  if (r.status >= 400 || !isObject(r.body)) return null;
  return r.body as unknown as ProofBundleResponse;
}

// ── VK material (for the proof-download bundle) ─────────────────────────────

export interface VkResponse {
  vkHash: string;
  groth16VkBytes: string;
  sp1Version: string;
  capturedAt: string;
}

/** Returns `null` if the coprocessor hasn't proven anything yet (503). */
export async function getVk(
  args: { envUrl?: string; signal?: AbortSignal } = {}
): Promise<VkResponse | null> {
  const r = await rawFetch('/proof/vk', args);
  if (r.status === 503) return null;
  if (r.status >= 500) {
    throw new CoprocessorUnreachableError(`proof/vk returned ${r.status}`);
  }
  if (r.status >= 400 || !isObject(r.body)) return null;
  return r.body as unknown as VkResponse;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
