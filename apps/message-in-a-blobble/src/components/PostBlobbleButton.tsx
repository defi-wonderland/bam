'use client';

import { useState } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';

async function fetchPendingCount(): Promise<number> {
  const res = await fetch('/api/messages?status=pending');
  const data = await res.json();
  return (data.messages || []).length;
}

async function postBlobble(): Promise<{ txHash: string; messageCount: number }> {
  const res = await fetch('/api/post-blobble', { method: 'POST' });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to post blobble');
  return data;
}

export function PostBlobbleButton() {
  const queryClient = useQueryClient();
  const [result, setResult] = useState<{ txHash: string; messageCount: number } | null>(null);

  const { data: pendingCount = 0 } = useQuery({
    queryKey: ['pendingCount'],
    queryFn: fetchPendingCount,
    refetchInterval: 5000,
  });

  const mutation = useMutation({
    mutationFn: postBlobble,
    onSuccess: (data) => {
      setResult(data);
      queryClient.invalidateQueries({ queryKey: ['messages'] });
      queryClient.invalidateQueries({ queryKey: ['pendingCount'] });
      queryClient.invalidateQueries({ queryKey: ['blobbles'] });
    },
  });

  if (pendingCount === 0 && !result) return null;

  return (
    <div className="card mb-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-bold text-ocean-700">Post Blobble</h3>
          <p className="text-sm text-ocean-500">
            {pendingCount > 0
              ? `${pendingCount} message${pendingCount !== 1 ? 's' : ''} ready to be sealed in a blob`
              : 'All messages posted!'}
          </p>
        </div>
        <button
          onClick={() => mutation.mutate()}
          disabled={pendingCount === 0 || mutation.isPending}
          className="btn-primary"
        >
          {mutation.isPending ? 'Posting...' : 'Post Blobble'}
        </button>
      </div>

      {result && (
        <div className="mt-4 p-3 bg-palm-50 border border-palm-200 rounded-lg">
          <p className="text-palm-800 font-bold">
            Blobble posted! {result.messageCount} message{result.messageCount !== 1 ? 's' : ''} on-chain.
          </p>
          <a
            href={`https://sepolia.etherscan.io/tx/${result.txHash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-ocean-600 hover:text-ocean-800 text-sm underline break-all"
          >
            View on Etherscan: {result.txHash}
          </a>
        </div>
      )}

      {mutation.isError && (
        <p className="text-red-500 text-sm mt-3">
          {mutation.error instanceof Error ? mutation.error.message : 'Failed to post'}
        </p>
      )}
    </div>
  );
}
