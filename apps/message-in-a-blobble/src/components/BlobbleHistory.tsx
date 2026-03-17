'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { AddressLink } from '@/components/AddressLink';

interface OnChainBlobble {
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

interface BlobbleDetail {
  txHash: string;
  blockNumber: number;
  blobVersionedHashes: string[];
  messageCount?: number;
  messages?: DecodedMessage[];
  note?: string;
}

async function fetchBlobbles(): Promise<OnChainBlobble[]> {
  const res = await fetch('/api/blobbles');
  const data = await res.json();
  return data.blobbles || [];
}

async function fetchBlobbleDetail(txHash: string): Promise<BlobbleDetail> {
  const res = await fetch(`/api/blobbles/${txHash}`);
  return res.json();
}

export function BlobbleHistory() {
  const { data: blobbles = [], isLoading } = useQuery({
    queryKey: ['blobbles'],
    queryFn: fetchBlobbles,
  });

  if (isLoading) {
    return <div className="text-center text-ocean-400 py-4">Loading on-chain blobbles...</div>;
  }

  if (blobbles.length === 0) {
    return null;
  }

  return (
    <div className="mt-8">
      <h3 className="text-lg font-bold text-ocean-700 mb-3">
        On-Chain Blobbles ({blobbles.length})
      </h3>
      <div className="space-y-3">
        {blobbles.map((b) => (
          <BlobbleCard key={b.txHash} blobble={b} />
        ))}
      </div>
    </div>
  );
}

function BlobbleCard({ blobble }: { blobble: OnChainBlobble }) {
  const [expanded, setExpanded] = useState(false);

  const { data: detail, isLoading } = useQuery({
    queryKey: ['blobbleDetail', blobble.txHash],
    queryFn: () => fetchBlobbleDetail(blobble.txHash),
    enabled: expanded,
  });

  return (
    <div className="card !p-4">
      <div className="flex items-center justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs px-2 py-0.5 rounded-full bg-ocean-100 text-ocean-700">
              Block {blobble.blockNumber}
            </span>
            <span className="text-xs text-sand-500">
              {new Date(blobble.timestamp * 1000).toLocaleString()}
            </span>
          </div>
          <a
            href={`https://sepolia.etherscan.io/tx/${blobble.txHash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-ocean-600 hover:text-ocean-800 text-xs font-mono underline break-all"
          >
            {blobble.txHash.slice(0, 18)}...{blobble.txHash.slice(-8)}
          </a>
        </div>
        <button
          onClick={() => setExpanded(!expanded)}
          className="ml-3 text-sm font-medium text-ocean-600 hover:text-white bg-ocean-100 hover:bg-ocean-600 px-3 py-1 rounded-md transition-colors whitespace-nowrap"
        >
          {expanded ? 'Hide' : 'Decode blob'}
        </button>
      </div>

      {expanded && isLoading && (
        <div className="mt-3 text-sm text-ocean-400">Fetching blob data...</div>
      )}

      {expanded && detail && <BlobbleDetails detail={detail} />}
    </div>
  );
}

function BlobbleDetails({ detail }: { detail: BlobbleDetail }) {
  if (detail.note && !detail.messages) {
    return (
      <div className="mt-3 p-3 bg-sand-50 rounded-lg">
        <p className="text-sm text-sand-600">{detail.note}</p>
        <p className="text-xs text-sand-400 mt-1">
          Versioned hash: {detail.blobVersionedHashes?.[0]?.slice(0, 18)}...
        </p>
      </div>
    );
  }

  if (!detail.messages || detail.messages.length === 0) {
    return (
      <div className="mt-3 text-sm text-sand-500">No messages decoded from blob</div>
    );
  }

  return (
    <div className="mt-3 space-y-2">
      <p className="text-sm text-palm-700 font-bold">
        {detail.messageCount} message{detail.messageCount !== 1 ? 's' : ''} decoded from blob
      </p>
      {detail.messages.map((m, i) => (
          <div key={i} className="p-2 bg-palm-50 rounded border border-palm-100">
            <div className="flex items-center justify-between mb-1">
              <AddressLink address={m.author} className="text-xs" />
              <span className="text-xs text-sand-500">
                {new Date(m.timestamp * 1000).toLocaleTimeString()}
              </span>
            </div>
            <p className="text-sm text-ocean-900">{m.content}</p>
          </div>
      ))}
    </div>
  );
}
