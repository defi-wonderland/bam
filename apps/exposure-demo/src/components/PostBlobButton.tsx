'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

interface PendingInfo {
  messages: Array<{ status: string }>;
}

export function PostBlobButton() {
  const [isPosting, setIsPosting] = useState(false);
  const [result, setResult] = useState<{
    txHash?: string;
    versionedHash?: string;
    messageCount?: number;
    error?: string;
  } | null>(null);
  const queryClient = useQueryClient();

  const { data } = useQuery<PendingInfo>({
    queryKey: ['messages'],
    queryFn: async () => {
      const res = await fetch('/api/messages');
      return res.json();
    },
  });

  const pendingCount = data?.messages?.filter((m) => m.status === 'pending').length ?? 0;

  const handlePost = async () => {
    setIsPosting(true);
    setResult(null);

    try {
      const res = await fetch('/api/post-blob', { method: 'POST' });
      const body = await res.json();

      if (!res.ok) {
        setResult({ error: body.error });
      } else {
        setResult({
          txHash: body.txHash,
          versionedHash: body.versionedHash,
          messageCount: body.messageCount,
        });
        queryClient.invalidateQueries({ queryKey: ['messages'] });
        queryClient.invalidateQueries({ queryKey: ['blobs'] });
      }
    } catch (err) {
      setResult({ error: err instanceof Error ? err.message : 'Unknown error' });
    } finally {
      setIsPosting(false);
    }
  };

  return (
    <div className="card">
      <h2 className="text-lg font-semibold mb-3">Step 3: Post Blob</h2>

      <div className="flex items-center gap-4">
        <button
          onClick={handlePost}
          disabled={isPosting || pendingCount === 0}
          className="btn-success"
        >
          {isPosting ? 'Posting blob...' : `Post Blob (${pendingCount} pending)`}
        </button>
        <span className="text-xs text-slate-400">
          Encodes messages into an EIP-4844 blob and calls registerBlob()
        </span>
      </div>

      {result?.error && (
        <p className="text-sm text-red-400 mt-2">{result.error}</p>
      )}

      {result?.txHash && (
        <div className="mt-3 p-3 rounded-lg bg-emerald-900/20 border border-emerald-800/30">
          <p className="text-sm text-emerald-300">
            Blob posted with {result.messageCount} message{result.messageCount !== 1 ? 's' : ''}
          </p>
          <a
            href={`https://sepolia.etherscan.io/tx/${result.txHash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="mono text-indigo-400 hover:text-indigo-300 underline"
          >
            {result.txHash.slice(0, 22)}...{result.txHash.slice(-8)}
          </a>
          {result.versionedHash && (
            <p className="mono mt-1">
              Versioned hash: {result.versionedHash.slice(0, 22)}...
            </p>
          )}
        </div>
      )}
    </div>
  );
}
