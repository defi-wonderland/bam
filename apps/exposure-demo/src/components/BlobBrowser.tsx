'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ExposeMessage } from './ExposeMessage';

interface OnChainBlob {
  versionedHash: string;
  submitter: string;
  timestamp: number;
  txHash: string;
  blockNumber: number;
}

interface DecodedMessage {
  author: string;
  content: string;
  timestamp: number;
  nonce: number;
}

interface BlobDetail {
  txHash: string;
  blockNumber: number;
  blobVersionedHashes: string[];
  messageCount?: number;
  messages?: DecodedMessage[];
  note?: string;
}

export function BlobBrowser() {
  const { data, isLoading } = useQuery<{ blobs: OnChainBlob[] }>({
    queryKey: ['blobs'],
    queryFn: async () => {
      const res = await fetch('/api/blobs');
      return res.json();
    },
    refetchInterval: 30_000,
  });

  const blobs = data?.blobs ?? [];

  return (
    <div className="card">
      <h2 className="text-lg font-semibold mb-3">
        Step 4: Browse Blobs {!isLoading && `(${blobs.length})`}
      </h2>

      {isLoading && <p className="text-sm text-slate-400">Loading registered blobs...</p>}

      <div className="space-y-3">
        {blobs.map((b) => (
          <BlobCard key={b.txHash} blob={b} />
        ))}
        {!isLoading && blobs.length === 0 && (
          <p className="text-sm text-slate-400">No registered blobs found in the last ~24h.</p>
        )}
      </div>
    </div>
  );
}

function BlobCard({ blob }: { blob: OnChainBlob }) {
  const [expanded, setExpanded] = useState(false);

  const { data: detail, isLoading } = useQuery<BlobDetail>({
    queryKey: ['blobDetail', blob.txHash],
    queryFn: async () => {
      const res = await fetch(`/api/blobs/${blob.txHash}`);
      return res.json();
    },
    enabled: expanded,
  });

  return (
    <div className="rounded-lg border border-slate-700/50 bg-slate-800/50 p-4">
      <div className="flex items-center justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span className="status-badge bg-indigo-900/50 text-indigo-300">
              Block {blob.blockNumber}
            </span>
            <span className="text-xs text-slate-500">
              {new Date(blob.timestamp * 1000).toLocaleString()}
            </span>
          </div>
          <a
            href={`https://sepolia.etherscan.io/tx/${blob.txHash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="mono text-indigo-400 hover:text-indigo-300 underline"
          >
            {blob.txHash.slice(0, 22)}...{blob.txHash.slice(-8)}
          </a>
        </div>
        <button
          onClick={() => setExpanded(!expanded)}
          className="btn-secondary ml-3 whitespace-nowrap"
        >
          {expanded ? 'Hide' : 'Decode & Expose'}
        </button>
      </div>

      {expanded && isLoading && (
        <p className="mt-3 text-sm text-slate-400">Fetching blob data...</p>
      )}

      {expanded && detail && (
        <BlobMessages detail={detail} txHash={blob.txHash} />
      )}
    </div>
  );
}

function BlobMessages({ detail, txHash }: { detail: BlobDetail; txHash: string }) {
  if (detail.note && !detail.messages) {
    return (
      <div className="mt-3 p-3 bg-slate-800 rounded-lg">
        <p className="text-sm text-slate-400">{detail.note}</p>
      </div>
    );
  }

  if (!detail.messages || detail.messages.length === 0) {
    return (
      <p className="mt-3 text-sm text-slate-400">No messages decoded from blob.</p>
    );
  }

  return (
    <div className="mt-3 space-y-2">
      <p className="text-sm text-slate-300 font-medium">
        {detail.messageCount} message{detail.messageCount !== 1 ? 's' : ''} in blob
      </p>
      {detail.messages.map((m, i) => (
        <div
          key={i}
          className="p-3 rounded-lg bg-slate-900/80 border border-slate-700/30"
        >
          <div className="flex items-center justify-between mb-1">
            <span className="mono text-slate-400">
              {m.author.slice(0, 10)}...{m.author.slice(-6)}
            </span>
            <span className="text-xs text-slate-500">
              nonce: {m.nonce} | {new Date(m.timestamp * 1000).toLocaleTimeString()}
            </span>
          </div>
          <p className="text-sm text-slate-200 mb-2">{m.content}</p>
          <ExposeMessage
            txHash={txHash}
            messageIndex={i}
            author={m.author}
            nonce={m.nonce}
            content={m.content}
            timestamp={m.timestamp}
          />
        </div>
      ))}
    </div>
  );
}
