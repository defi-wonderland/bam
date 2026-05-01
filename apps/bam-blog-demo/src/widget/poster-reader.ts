/**
 * Browser-side typed `fetch` helpers for the demo's read/write
 * surface.
 *
 * Two modes, decided at build time by the presence of
 * `VITE_POSTER_URL` and `VITE_READER_URL`:
 *
 *   - **Direct mode** (both env vars set): the widget calls the
 *     upstream Poster + Reader directly. The bundle is then
 *     fully self-contained and can be served from any static
 *     host. Requires the upstream services to send permissive
 *     CORS headers.
 *
 *   - **Proxy mode** (env vars empty): the widget calls
 *     same-origin `/api/*` routes. The companion `server.ts`
 *     proxies those to the upstreams. This is the default for
 *     `pnpm dev` and the path other apps in this workspace
 *     also use.
 *
 * The widget consumes the Reader's native row shape
 * (`messageHash`, `author`, `batchRef`, `blockNumber`) in both
 * modes — `server.ts` passes the Reader response through
 * unchanged in proxy mode.
 *
 * Failures surface as `Error` with stable string messages.
 */

import type { Hex } from 'viem';

import { BLOG_DEMO_CONTENT_TAG, KNOWN_CONTENT_TAGS } from './content-tag.js';

const POSTER_URL = (
  (import.meta.env.VITE_POSTER_URL as string | undefined) ?? ''
).replace(/\/$/, '');
const READER_URL = (
  (import.meta.env.VITE_READER_URL as string | undefined) ?? ''
).replace(/\/$/, '');

const DIRECT_MODE = POSTER_URL.length > 0 && READER_URL.length > 0;

export interface PendingRow {
  readonly sender: Hex;
  readonly nonce: string;
  readonly contents: Hex;
  readonly messageHash: Hex;
  readonly ingestedAt: number;
}

/**
 * Native Reader row shape (also what `server.ts` returns in
 * proxy mode). The widget normalizes on these field names.
 */
export interface ConfirmedRow {
  readonly messageHash: Hex;
  readonly author: Hex;
  readonly nonce: string;
  readonly contents: Hex;
  readonly signature: Hex;
  readonly batchRef: Hex | null;
  readonly blockNumber: number | null;
}

export interface SubmitArgs {
  readonly contentTag: Hex;
  readonly sender: Hex;
  readonly nonce: bigint;
  readonly contents: Hex;
  readonly signature: Hex;
}

export interface SubmitResult {
  readonly accepted: boolean;
  readonly reason?: string;
}

export async function fetchPending(): Promise<PendingRow[]> {
  const url = DIRECT_MODE
    ? `${POSTER_URL}/pending?contentTag=${encodeURIComponent(
        BLOG_DEMO_CONTENT_TAG
      )}`
    : '/api/messages';
  const res = await fetch(url);
  if (!res.ok) throw new Error(`pending fetch failed: ${res.status}`);
  const data = (await res.json()) as { pending?: PendingRow[] };
  return data.pending ?? [];
}

export async function fetchConfirmed(): Promise<ConfirmedRow[]> {
  const url = DIRECT_MODE
    ? `${READER_URL}/messages?contentTag=${encodeURIComponent(
        BLOG_DEMO_CONTENT_TAG
      )}&status=confirmed`
    : '/api/confirmed-messages';
  const res = await fetch(url);
  if (!res.ok) throw new Error(`confirmed fetch failed: ${res.status}`);
  const data = (await res.json()) as { messages?: ConfirmedRow[] };
  // In direct mode, drop rows that don't have a batchRef yet — the
  // Reader can return such rows during a tx-pending → confirmed
  // transition. The proxy already filters these.
  const rows = data.messages ?? [];
  return DIRECT_MODE ? rows.filter((r) => r.batchRef !== null) : rows;
}

interface PosterPendingFanout {
  pending?: Array<{ sender: string; nonce: string | number }>;
}
interface ReaderConfirmedFanout {
  messages?: Array<{ author: string; nonce: string }>;
}

export async function fetchNextNonce(sender: Hex): Promise<bigint> {
  if (!DIRECT_MODE) {
    const res = await fetch(
      `/api/next-nonce?sender=${encodeURIComponent(sender)}`
    );
    if (!res.ok) throw new Error(`next-nonce lookup failed: ${res.status}`);
    const data = (await res.json()) as { nextNonce?: string };
    if (typeof data.nextNonce !== 'string') {
      throw new Error('next-nonce response missing nextNonce');
    }
    return BigInt(data.nextNonce);
  }

  // Direct mode: same logic server.ts implements, but client-side.
  const lc = sender.toLowerCase();
  let max = -1n;

  const pendingRes = await fetch(`${POSTER_URL}/pending`);
  if (!pendingRes.ok) {
    throw new Error(`poster /pending: ${pendingRes.status}`);
  }
  const pendingData = (await pendingRes.json()) as PosterPendingFanout;
  for (const p of pendingData.pending ?? []) {
    if (p.sender.toLowerCase() !== lc) continue;
    const n = parseNonce(p.nonce);
    if (n !== null && n > max) max = n;
  }

  for (const tag of KNOWN_CONTENT_TAGS) {
    const r = await fetch(
      `${READER_URL}/messages?contentTag=${encodeURIComponent(tag)}&status=confirmed`
    );
    if (!r.ok) throw new Error(`reader /messages for ${tag}: ${r.status}`);
    const data = (await r.json()) as ReaderConfirmedFanout;
    for (const row of data.messages ?? []) {
      if (row.author.toLowerCase() !== lc) continue;
      const n = parseNonce(row.nonce);
      if (n !== null && n > max) max = n;
    }
  }
  return max + 1n;
}

function parseNonce(v: string | number): bigint | null {
  try {
    return BigInt(v);
  } catch {
    return null;
  }
}

export async function submitMessage(args: SubmitArgs): Promise<SubmitResult> {
  const envelope = {
    contentTag: args.contentTag,
    message: {
      sender: args.sender,
      nonce: args.nonce.toString(),
      contents: args.contents,
      signature: args.signature,
    },
  };
  const url = DIRECT_MODE ? `${POSTER_URL}/submit` : '/api/messages';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope),
  });
  if (res.ok) return { accepted: true };
  let reason: string | undefined;
  try {
    const data = (await res.json()) as { reason?: string; error?: string };
    reason = data.reason ?? data.error;
  } catch {
    // ignore
  }
  return { accepted: false, reason };
}

export async function flushBatch(): Promise<void> {
  const url = DIRECT_MODE
    ? `${POSTER_URL}/flush?contentTag=${encodeURIComponent(BLOG_DEMO_CONTENT_TAG)}`
    : '/api/post-blobble';
  await fetch(url, { method: 'POST' }).catch(() => {});
}
