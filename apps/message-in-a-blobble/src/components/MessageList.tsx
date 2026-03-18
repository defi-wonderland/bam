'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { AddressLink } from '@/components/AddressLink';
import { SyncStatus } from '@/components/SyncStatus';

interface Message {
  id: number;
  message_id: string;
  author: string;
  timestamp: number;
  content: string;
  status: 'pending' | 'posted';
  blobble_id: string | null;
  tx_hash: string | null;
  block_number: number | null;
  created_at: string;
}

async function fetchMessages(): Promise<Message[]> {
  const res = await fetch('/api/messages');
  const data = await res.json();
  return data.messages || [];
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
          ({messages.length} message{messages.length !== 1 ? 's' : ''} in DB
          {pending.length > 0 ? `, ${pending.length} pending` : ''}
          {posted.length > 0 ? `, ${posted.length} posted` : ''})
        </span>
      </button>
      {showIndexed && (
        <div className="mt-3 space-y-4 pl-4 border-l-2 border-sand-200">
          <SyncStatus />
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

function MessageCard({ message }: { message: Message }) {
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
