/**
 * Direct-to-upstream HTTP for the BAM Poster + Reader. The widget is
 * a script-tag drop-in: there is no Node proxy in front of these
 * services. URLs are baked at build time via `VITE_POSTER_URL` /
 * `VITE_READER_URL` (Vite substitutes `import.meta.env.*`).
 *
 * Response handling is intentionally narrow:
 *   - JSON only;
 *   - any non-2xx → typed `UpstreamError`;
 *   - the `/nonce/<sender>` failure mode is propagated to the caller
 *     (no fall-back to `/pending` scanning) — see comment in
 *     `getNextNonce` for why.
 */

import { computeMessageHash } from 'bam-sdk/browser';

import { decodeCommentContents } from './codec.js';
import { hexToBytes, bytesToHex } from './hex.js';
import type { DecodedMessage } from './thread.js';

declare global {
  interface ImportMeta {
    env: {
      VITE_POSTER_URL: string;
      VITE_READER_URL: string;
    };
  }
}

const POSTER_URL = import.meta.env.VITE_POSTER_URL;
const READER_URL = import.meta.env.VITE_READER_URL;

export class UpstreamError extends Error {
  readonly kind: 'http' | 'network' | 'shape';
  readonly status?: number;
  constructor(kind: 'http' | 'network' | 'shape', message: string, status?: number) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

/**
 * GET `/nonce/<sender>` from the Poster. Authoritative across every
 * contentTag the Poster serves, so we never fan out across sibling
 * apps' tags. On any non-2xx we surface a hard `UpstreamError` rather
 * than falling back to `/pending` — an underestimated `nextNonce`
 * round-trips through the composer's `stale_nonce` retry loop and
 * exhausts on a stuck max, hiding the upstream problem behind wallet
 * popups. Failing fast keeps the failure mode legible.
 */
export async function getNextNonce(sender: `0x${string}`): Promise<bigint> {
  const path = `/nonce/${encodeURIComponent(sender.toLowerCase())}`;
  const data = await jsonGet(`${POSTER_URL}${path}`);
  const v = (data as { nextNonce?: unknown }).nextNonce;
  if (typeof v !== 'string') {
    throw new UpstreamError('shape', 'nextNonce missing or not a string');
  }
  // The endpoint contract is "decimal uint64 as string"; reject
  // anything else (hex, leading sign, scientific) so an upstream
  // contract drift surfaces here rather than silently producing a
  // wrong nonce that would fail `stale_nonce` repeatedly.
  if (!/^[0-9]+$/.test(v)) {
    throw new UpstreamError('shape', `nextNonce not a decimal uint64: ${v}`);
  }
  const n = BigInt(v);
  // Enforce the uint64 upper bound here rather than letting an
  // out-of-range nonce blow up later inside `computeMessageHash`
  // (which throws a generic RangeError that's hard to attribute back
  // to upstream drift).
  if (n > 0xffffffffffffffffn) {
    throw new UpstreamError('shape', `nextNonce out of uint64 range: ${v}`);
  }
  return n;
}

export interface SubmitArgs {
  contentTag: `0x${string}`;
  sender: `0x${string}`;
  nonce: bigint;
  contents: Uint8Array;
  signature: `0x${string}`;
}

export interface SubmitFailure {
  ok: false;
  status: number;
  reason: string;
  detail?: string;
}

export interface SubmitSuccess {
  ok: true;
  messageHash: `0x${string}`;
}

/**
 * `POST /submit?contentTag=<tag>` with the binary envelope. Mirrors
 * what `bam-twitter`'s proxy + Poster client does, but inlined here
 * — the widget can't depend on a Next.js server. We construct the
 * envelope here (sender ‖ nonce ‖ contents ‖ signature) so the
 * caller deals only with the high-level fields.
 */
export async function submitMessage(args: SubmitArgs): Promise<SubmitSuccess | SubmitFailure> {
  const envelope = encodeEnvelope(args);
  const url = `${POSTER_URL}/submit?contentTag=${encodeURIComponent(args.contentTag)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: envelope,
    });
  } catch (err) {
    throw new UpstreamError(
      'network',
      err instanceof Error ? err.message : 'submit fetch failed'
    );
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const reason =
      (body as { reason?: string } | null)?.reason ??
      (body as { error?: string } | null)?.error ??
      `http_${res.status}`;
    return { ok: false, status: res.status, reason };
  }
  // Poster returns the same messageHash we can compute locally; we
  // recompute to avoid trusting an unauthenticated body field.
  const messageHash = computeMessageHash(
    args.sender,
    args.contentTag,
    args.nonce,
    args.contents
  );
  return { ok: true, messageHash: messageHash as `0x${string}` };
}

/**
 * Build the JSON envelope `parseEnvelope` (poster/ingest/envelope.ts)
 * accepts: `{ contentTag, message: { sender, nonce, contents,
 * signature } }`. Nonce is encoded as a decimal string so values
 * above 2^53 round-trip without precision loss.
 */
function encodeEnvelope(args: SubmitArgs): string {
  return JSON.stringify({
    contentTag: args.contentTag,
    message: {
      sender: args.sender,
      nonce: args.nonce.toString(),
      contents: bytesToHex(args.contents),
      signature: args.signature,
    },
  });
}

export interface ListMessagesArgs {
  contentTag: `0x${string}`;
  status?: 'pending' | 'submitted' | 'confirmed';
  limit?: number;
  signal?: AbortSignal;
}

interface ReaderRow {
  messageHash: string;
  sender: string;
  nonce: string;
  contents: string;
  status?: string;
  /**
   * Set once the Reader has linked this message to an on-chain batch.
   * Confirmed rows can briefly arrive with `batchRef === null` during
   * the tx-pending → confirmed transition; we drop those upstream of
   * decoding so they don't render as half-confirmed ghosts.
   */
  batchRef?: string | null;
  /** Fallback timestamp surfaced by the Reader for sort-order debugging. */
  acceptedAt?: number;
}

/**
 * `GET /messages?contentTag=...&status=...`. Pulls confirmed +
 * pending rows and decodes the comments envelope. Rows we can't
 * decode (bad version, kind, utf-8) are dropped — a bad row is the
 * Poster's job to reject before storage; if one slipped through we'd
 * rather render the rest than fail the whole thread.
 */
export async function listMessages(
  args: ListMessagesArgs
): Promise<DecodedMessage[]> {
  const q = new URLSearchParams();
  q.set('contentTag', args.contentTag);
  if (args.status !== undefined) q.set('status', args.status);
  if (args.limit !== undefined) q.set('limit', String(args.limit));
  // `bam-reader` exposes `/messages` (returns `{ messages: [...] }`);
  // the Poster's `/pending` returns `{ pending: [...] }`. Field name
  // diverges, body shape is otherwise identical.
  const isPending = args.status === 'pending';
  const base = isPending ? `${POSTER_URL}/pending` : `${READER_URL}/messages`;
  const data = await jsonGet(`${base}?${q.toString()}`, { signal: args.signal });
  const rows = isPending
    ? (data as { pending?: unknown }).pending
    : (data as { messages?: unknown }).messages;
  if (!Array.isArray(rows)) {
    throw new UpstreamError('shape', 'list response missing rows[]');
  }
  const decoded: DecodedMessage[] = [];
  for (const r of rows as ReaderRow[]) {
    const m = decodeRow(r, args.contentTag, args.status === 'pending');
    if (m !== null) decoded.push(m);
  }
  return decoded;
}

function decodeRow(
  row: ReaderRow,
  contentTag: `0x${string}`,
  pending: boolean
): DecodedMessage | null {
  // The Reader marks a row "confirmed" the moment its tx is included
  // but populates `batchRef` after a second pass; treat such rows as
  // not-yet-renderable so we don't briefly de-duplicate them against
  // their own pending mirror under a stale messageHash.
  if (!pending && row.batchRef === null) return null;
  try {
    const contents = hexToBytes(row.contents);
    const envelope = decodeCommentContents(contents);
    if (typeof row.sender !== 'string') return null;
    const sender = row.sender as `0x${string}`;
    const nonce = BigInt(row.nonce);
    const messageHash = computeMessageHash(
      sender,
      contentTag,
      nonce,
      contents
    ) as `0x${string}`;
    const parentMessageHash =
      envelope.kind === 'reply' ? envelope.parentMessageHash : undefined;
    return {
      messageHash,
      sender,
      senderLower: sender.toLowerCase(),
      postIdHash: envelope.postIdHash,
      timestamp: envelope.timestamp,
      content: envelope.content,
      parentMessageHash,
      pending,
    };
  } catch {
    return null;
  }
}

async function jsonGet(url: string, init?: { signal?: AbortSignal }): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { method: 'GET', signal: init?.signal });
  } catch (err) {
    throw new UpstreamError(
      'network',
      err instanceof Error ? err.message : 'fetch failed'
    );
  }
  if (!res.ok) {
    throw new UpstreamError('http', `${url} → ${res.status}`, res.status);
  }
  try {
    return await res.json();
  } catch (err) {
    throw new UpstreamError(
      'shape',
      err instanceof Error ? err.message : 'response not JSON'
    );
  }
}

/**
 * Convenience: pull every message under `contentTag` and project it
 * to the bucket of comments for one `postIdHash`. Used by the
 * renderer's polling loop.
 */
export async function listForPost(args: {
  contentTag: `0x${string}`;
  postIdHash: `0x${string}`;
  limit?: number;
  signal?: AbortSignal;
}): Promise<DecodedMessage[]> {
  // Hit pending and confirmed in parallel; merge by messageHash so a
  // confirmed row replaces its earlier pending mirror.
  const [pending, confirmed] = await Promise.all([
    listMessages({
      contentTag: args.contentTag,
      status: 'pending',
      limit: args.limit,
      signal: args.signal,
    }).catch(() => [] as DecodedMessage[]),
    listMessages({
      contentTag: args.contentTag,
      status: 'confirmed',
      limit: args.limit,
      signal: args.signal,
    }),
  ]);
  const seen = new Map<string, DecodedMessage>();
  for (const m of pending) seen.set(m.messageHash.toLowerCase(), m);
  for (const m of confirmed) seen.set(m.messageHash.toLowerCase(), m);
  const target = args.postIdHash.toLowerCase();
  return [...seen.values()].filter((m) => m.postIdHash.toLowerCase() === target);
}
