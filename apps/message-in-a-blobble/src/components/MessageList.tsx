'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { AddressLink } from '@/components/AddressLink';

/**
 * Post-migration, the UI renders two independent data sources:
 *  - **pending**: from the Poster's `/pending` surface (via
 *    `/api/messages`). In flight, not yet on chain.
 *  - **posted**:  from the demo's own DB, written by the sync
 *    indexer after it observes `BlobBatchRegistered` events and
 *    decodes the blobs (via `/api/confirmed-messages`). On chain.
 *
 * Both are coerced into a single `DisplayMessage` shape so the
 * render code stays uniform.
 */
interface DisplayMessage {
  id: string;
  author: string;
  timestamp: number;
  /**
   * Decimal-string nonce to preserve uint64 precision (future-compatible
   * with NEXT_SPEC's widening). Not rendered — only consumed by
   * `MessageComposer`'s next-nonce computation, which parses via BigInt.
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

async function fetchMessages(): Promise<DisplayMessage[]> {
  const [pending, confirmed] = await Promise.all([fetchPending(), fetchConfirmed()]);
  return [...pending, ...confirmed].sort((a, b) => b.timestamp - a.timestamp);
}

export function MessageList() {
  const { data: messages = [], isLoading } = useQuery({
    queryKey: ['messages'],
    queryFn: fetchMessages,
    refetchInterval: 5000,
  });

  const [showIndexed, setShowIndexed] = useState(false);

  if (isLoading) {
    return <div className="text-center text-ocean-400 py-8">Loading messages...</div>;
  }

  if (messages.length === 0) {
    return (
      <div className="text-center text-ocean-400 py-8">
        No messages yet. Be the first to cast a message into the blobble!
      </div>
    );
  }

  const pending = messages.filter((m) => m.status === 'pending');
  const posted = messages.filter((m) => m.status === 'posted');

  return (
    <div className="mt-8">
      <button
        type="button"
        onClick={() => setShowIndexed(!showIndexed)}
        className="flex items-center gap-2 text-left w-full text-sm text-sand-600 hover:text-ocean-700 focus:outline-none focus:ring-2 focus:ring-ocean-300 rounded px-1 -mx-1"
        aria-expanded={showIndexed}
      >
        <span
          className="inline-block transition-transform"
          style={{ transform: showIndexed ? 'rotate(90deg)' : 'none' }}
        >
          ▶
        </span>
        <span className="font-medium">Indexed blobbles</span>
        <span className="text-sand-400 font-normal">
          ({messages.length} message{messages.length !== 1 ? 's' : ''} in view
          {pending.length > 0 ? `, ${pending.length} pending` : ''}
          {posted.length > 0 ? `, ${posted.length} posted` : ''})
        </span>
      </button>
      {showIndexed && (
        <div className="mt-3 space-y-4 pl-4 border-l-2 border-sand-200">
          {pending.length > 0 && (
            <div>
              <h4 className="text-sm font-semibold text-sand-600 mb-2">Pending ({pending.length})</h4>
              <div className="space-y-3">
                {pending.map((m) => (
                  <MessageCard key={m.id} message={m} />
                ))}
              </div>
            </div>
          )}
          {posted.length > 0 && (
            <div>
              <h4 className="text-sm font-semibold text-sand-600 mb-2">Posted ({posted.length})</h4>
              <div className="space-y-3">
                {posted.map((m) => (
                  <MessageCard key={m.id} message={m} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MessageCard({ message }: { message: DisplayMessage }) {
  const time = new Date(message.timestamp * 1000).toLocaleTimeString();

  return (
    <div className="message-card">
      <div className="flex items-center justify-between mb-2">
        <AddressLink address={message.author} className="text-sm" />
        <div className="flex items-center gap-2">
          <span className="text-xs text-sand-500">{time}</span>
          <span
            className={`text-xs px-2 py-0.5 rounded-full ${
              message.status === 'pending'
                ? 'bg-sand-200 text-sand-700'
                : 'bg-palm-100 text-palm-700'
            }`}
          >
            {message.status === 'pending' ? 'in bottle' : 'on-chain'}
          </span>
        </div>
      </div>
      <p className="text-ocean-900 whitespace-pre-wrap break-words">{message.content}</p>
      {message.tx_hash && (
        <div className="mt-2 flex items-center gap-2 text-xs text-sand-500">
          {message.block_number != null && (
            <span className="px-1.5 py-0.5 rounded bg-ocean-50 text-ocean-600">
              Block {message.block_number}
            </span>
          )}
          <a
            href={`https://sepolia.etherscan.io/tx/${message.tx_hash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-ocean-600 hover:text-ocean-800 underline"
          >
            {message.tx_hash.slice(0, 10)}...{message.tx_hash.slice(-6)}
          </a>
        </div>
      )}
    </div>
  );
}
