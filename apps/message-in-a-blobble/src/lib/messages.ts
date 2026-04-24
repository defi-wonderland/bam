/**
 * Shared data source for the merged pending + confirmed message list.
 *
 * Both `MessageList` (renders them) and `PostBlobbleButton` (derives a
 * pending count) subscribe to the same `['messages']` react-query key
 * — so only one poller hits `/api/messages` + `/api/confirmed-messages`
 * per interval, regardless of how many components consume the data.
 *
 * Feature 002: the Poster and the sync indexer both return
 * `BAMMessage`-shaped rows (`sender`, `nonce`, `contents`). The demo
 * decodes `contents` via the shared `contents-codec` before passing
 * display rows up to `DisplayMessage`.
 */

import { decodeSocialContents } from './contents-codec';

export interface DisplayMessage {
  id: string;
  sender: string;
  timestamp: number;
  nonce: string;
  content: string;
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
  const out = new Uint8Array(c.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(c.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function safeDecode(contentsHex: string): { timestamp: number; content: string } | null {
  try {
    const { app } = decodeSocialContents(hexToBytes(contentsHex));
    return app;
  } catch {
    return null;
  }
}

async function fetchPending(): Promise<DisplayMessage[]> {
  const res = await fetch('/api/messages');
  if (!res.ok) return [];
  const data = (await res.json()) as { pending?: PosterPendingRow[] };
  const out: DisplayMessage[] = [];
  for (const p of data.pending ?? []) {
    const app = safeDecode(p.contents);
    if (app === null) continue; // codec drift — skip rather than render garbage
    out.push({
      id: p.messageHash,
      sender: p.sender,
      timestamp: app.timestamp,
      nonce: String(p.nonce),
      content: app.content,
      status: 'pending' as const,
    });
  }
  return out;
}

async function fetchConfirmed(): Promise<DisplayMessage[]> {
  const res = await fetch('/api/confirmed-messages');
  if (!res.ok) return [];
  const data = (await res.json()) as { messages?: ConfirmedRow[] };
  const out: DisplayMessage[] = [];
  for (const m of data.messages ?? []) {
    const app = safeDecode(m.contents);
    if (app === null) continue;
    out.push({
      id: m.message_id,
      sender: m.sender,
      timestamp: app.timestamp,
      nonce: m.nonce,
      content: app.content,
      status: 'posted' as const,
      tx_hash: m.tx_hash,
      block_number: m.block_number,
    });
  }
  return out;
}

export async function fetchMessages(): Promise<DisplayMessage[]> {
  const [pendingRes, confirmedRes] = await Promise.allSettled([
    fetchPending(),
    fetchConfirmed(),
  ]);
  const pending = pendingRes.status === 'fulfilled' ? pendingRes.value : [];
  const confirmed = confirmedRes.status === 'fulfilled' ? confirmedRes.value : [];
  return [...pending, ...confirmed].sort((a, b) => b.timestamp - a.timestamp);
}

export const MESSAGES_QUERY_KEY = ['messages'] as const;
export const MESSAGES_REFETCH_MS = 5000;
