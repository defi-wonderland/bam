/**
 * Shared data source for the merged pending + confirmed message list.
 *
 * Both `MessageList` (renders them) and `PostBlobbleButton` (derives a
 * pending count) subscribe to the same `['messages']` react-query key
 * — so only one poller hits `/api/messages` + `/api/confirmed-messages`
 * per interval, regardless of how many components consume the data.
 */

export interface DisplayMessage {
  id: string;
  author: string;
  timestamp: number;
  /**
   * Decimal-string nonce to preserve uint64 precision (future-compatible
   * with NEXT_SPEC's widening). Consumed by `MessageComposer`'s
   * next-nonce computation via BigInt.
   */
  nonce: string;
  content: string;
  status: 'pending' | 'posted';
  tx_hash?: string | null;
  block_number?: number | null;
}

interface PosterPendingRow {
  messageId: string;
  author: string;
  nonce: string | number;
  content: string;
  timestamp: number;
  ingestedAt: number;
}

interface ConfirmedRow {
  message_id: string;
  author: string;
  timestamp: number;
  nonce: string;
  content: string;
  tx_hash: string | null;
  block_number: number | null;
}

async function fetchPending(): Promise<DisplayMessage[]> {
  const res = await fetch('/api/messages');
  if (!res.ok) return [];
  const data = (await res.json()) as { pending?: PosterPendingRow[] };
  return (data.pending ?? []).map((p) => ({
    id: p.messageId,
    author: p.author,
    timestamp: p.timestamp,
    nonce: String(p.nonce),
    content: p.content,
    status: 'pending' as const,
  }));
}

async function fetchConfirmed(): Promise<DisplayMessage[]> {
  const res = await fetch('/api/confirmed-messages');
  if (!res.ok) return [];
  const data = (await res.json()) as { messages?: ConfirmedRow[] };
  return (data.messages ?? []).map((m) => ({
    id: m.message_id,
    author: m.author,
    timestamp: m.timestamp,
    nonce: m.nonce,
    content: m.content,
    status: 'posted' as const,
    tx_hash: m.tx_hash,
    block_number: m.block_number,
  }));
}

export async function fetchMessages(): Promise<DisplayMessage[]> {
  // allSettled, not all: pending and confirmed come from independent
  // backends (/api/messages → Poster vs /api/confirmed-messages →
  // demo DB). One flaky endpoint should degrade the corresponding
  // list, not blank both (cubic review).
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
