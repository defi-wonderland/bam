/**
 * Browser-side typed `fetch` helpers for the four same-origin API
 * routes the demo's dev/prod server (`server.ts`) exposes:
 *
 *   GET  /api/messages           pending feed for this app's contentTag
 *   POST /api/messages           submit a signed envelope
 *   GET  /api/confirmed-messages confirmed feed for this app's contentTag
 *   POST /api/post-blobble       nudge the Poster's per-tag flush
 *   GET  /api/next-nonce         per-sender next-nonce across all tags
 *
 * The widget never knows the upstream Poster/Reader URLs — those
 * are server-side env (`POSTER_URL`, `READER_URL`). All paths
 * here are same-origin.
 *
 * Failures are surfaced as `Error` with stable string messages
 * the renderer can map to user-facing text. We do not leak raw
 * fetch / network errors verbatim.
 */

import type { Hex } from 'viem';

export interface PendingRow {
  readonly sender: Hex;
  readonly nonce: string;
  /** hex-encoded contents (post-tag-prefix + app payload). */
  readonly contents: Hex;
  readonly messageHash: Hex;
  readonly ingestedAt: number;
}

export interface ConfirmedRow {
  readonly message_id: Hex;
  readonly sender: Hex;
  readonly nonce: string;
  readonly contents: Hex;
  readonly signature: Hex;
  readonly tx_hash: Hex | null;
  readonly block_number: number | null;
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
  const res = await fetch('/api/messages');
  if (!res.ok) {
    throw new Error(`pending fetch failed: ${res.status}`);
  }
  const data = (await res.json()) as { pending?: PendingRow[] };
  return data.pending ?? [];
}

export async function fetchConfirmed(): Promise<ConfirmedRow[]> {
  const res = await fetch('/api/confirmed-messages');
  if (!res.ok) {
    throw new Error(`confirmed fetch failed: ${res.status}`);
  }
  const data = (await res.json()) as { messages?: ConfirmedRow[] };
  return data.messages ?? [];
}

export async function fetchNextNonce(sender: Hex): Promise<bigint> {
  const res = await fetch(
    `/api/next-nonce?sender=${encodeURIComponent(sender)}`
  );
  if (!res.ok) {
    throw new Error(`next-nonce lookup failed: ${res.status}`);
  }
  const data = (await res.json()) as { nextNonce?: string };
  if (typeof data.nextNonce !== 'string') {
    throw new Error('next-nonce response missing nextNonce');
  }
  return BigInt(data.nextNonce);
}

/**
 * POST a signed envelope to the Poster (via the same-origin
 * proxy). Returns `{ accepted, reason? }` mirroring the Poster's
 * stable wire shape so the renderer can branch on `reason ===
 * 'stale_nonce'` for the Composer's retry loop without parsing
 * free-form text.
 */
export async function submitMessage(args: SubmitArgs): Promise<SubmitResult> {
  const body = JSON.stringify({
    contentTag: args.contentTag,
    message: {
      sender: args.sender,
      nonce: args.nonce.toString(),
      contents: args.contents,
      signature: args.signature,
    },
  });
  const res = await fetch('/api/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  if (res.ok) {
    return { accepted: true };
  }
  let reason: string | undefined;
  try {
    const data = (await res.json()) as { reason?: string; error?: string };
    reason = data.reason ?? data.error;
  } catch {
    // ignore — fall through with no reason
  }
  return { accepted: false, reason };
}

/**
 * Tells the Poster to immediately flush this app's pending
 * batch. Best-effort; the Poster runs the submission loop on
 * its own cadence and a flush just nudges it.
 */
export async function flushBatch(): Promise<void> {
  await fetch('/api/post-blobble', { method: 'POST' }).catch(() => {});
}
