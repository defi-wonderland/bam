/**
 * Shared data source for the merged pending + confirmed tweet feed.
 * Decodes the kind-tagged envelope so the UI gets `DisplayTweet`
 * rows with `parentMessageHash` lifted out — Composer reuses this
 * via the `MESSAGES_QUERY_KEY` cache so we only poll once per
 * interval regardless of how many components subscribe.
 */

import { decodeTwitterContents } from './contents-codec';
import type { Bytes32 } from 'bam-sdk/browser';

export interface DisplayTweet {
  id: string;
  sender: string;
  nonce: string;
  timestamp: number;
  content: string;
  /** null for top-level posts; set for replies. */
  parentMessageHash: Bytes32 | null;
  status: 'pending' | 'posted';
  tx_hash?: string | null;
  block_number?: number | null;
}

interface PosterPendingRow {
  sender: string;
  nonce: string | number;
  contents: string;
  messageHash: string;
  ingestedAt: number;
}

interface ConfirmedRow {
  message_id: string;
  sender: string;
  nonce: string;
  contents: string;
  tx_hash: string | null;
  block_number: number | null;
}

function hexToBytes(hex: string): Uint8Array {
  const c = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (c.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(c)) {
    throw new Error('invalid hex contents');
  }
  const out = new Uint8Array(c.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(c.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function safeDecode(contentsHex: string): {
  timestamp: number;
  content: string;
  parentMessageHash: Bytes32 | null;
} | null {
  try {
    const { app } = decodeTwitterContents(hexToBytes(contentsHex));
    if (app.kind === 'reply') {
      return {
        timestamp: app.timestamp,
        content: app.content,
        parentMessageHash: app.parentMessageHash,
      };
    }
    return {
      timestamp: app.timestamp,
      content: app.content,
      parentMessageHash: null,
    };
  } catch {
    return null;
  }
}

async function fetchPending(): Promise<DisplayTweet[]> {
  const res = await fetch('/api/messages');
  if (!res.ok) return [];
  const data = (await res.json()) as { pending?: PosterPendingRow[] };
  const out: DisplayTweet[] = [];
  for (const p of data.pending ?? []) {
    const app = safeDecode(p.contents);
    if (app === null) continue;
    out.push({
      id: p.messageHash,
      sender: p.sender,
      nonce: String(p.nonce),
      timestamp: app.timestamp,
      content: app.content,
      parentMessageHash: app.parentMessageHash,
      status: 'pending',
    });
  }
  return out;
}

async function fetchConfirmed(): Promise<DisplayTweet[]> {
  const res = await fetch('/api/confirmed-messages');
  if (!res.ok) return [];
  const data = (await res.json()) as { messages?: ConfirmedRow[] };
  const out: DisplayTweet[] = [];
  for (const m of data.messages ?? []) {
    const app = safeDecode(m.contents);
    if (app === null) continue;
    out.push({
      id: m.message_id,
      sender: m.sender,
      nonce: m.nonce,
      timestamp: app.timestamp,
      content: app.content,
      parentMessageHash: app.parentMessageHash,
      status: 'posted',
      tx_hash: m.tx_hash,
      block_number: m.block_number,
    });
  }
  return out;
}

export async function fetchTweets(): Promise<DisplayTweet[]> {
  const [pendingRes, confirmedRes] = await Promise.allSettled([
    fetchPending(),
    fetchConfirmed(),
  ]);
  const pending = pendingRes.status === 'fulfilled' ? pendingRes.value : [];
  const confirmed = confirmedRes.status === 'fulfilled' ? confirmedRes.value : [];

  // Same id can appear in both lists during a tx_pending → confirmed
  // transition. Prefer the confirmed row.
  const seen = new Set<string>();
  const out: DisplayTweet[] = [];
  for (const t of confirmed) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
  }
  for (const t of pending) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
  }
  return out.sort((a, b) => b.timestamp - a.timestamp);
}

export const TWEETS_QUERY_KEY = ['tweets'] as const;
export const TWEETS_REFETCH_MS = 5000;
