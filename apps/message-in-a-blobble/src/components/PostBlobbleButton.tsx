'use client';

import { useState, useEffect } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';

interface PosterStatus {
  address: string;
  balance: string | null;
  lastPostTime: number | null;
  nextEligibleTime: number | null;
  cooldownRemainingMs: number;
  canPostNow: boolean;
}

async function fetchPendingCount(): Promise<number> {
  const res = await fetch('/api/messages?status=pending');
  const data = await res.json();
  return (data.messages || []).length;
}

async function fetchPosterStatus(): Promise<PosterStatus> {
  const res = await fetch('/api/poster-status');
  if (!res.ok) throw new Error('Failed to fetch poster status');
  return res.json();
}

async function postBlobble(): Promise<{ txHash: string; messageCount: number }> {
  const res = await fetch('/api/post-blobble', { method: 'POST' });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to post blobble');
  return data;
}

function CooldownTimer({ nextEligibleTime }: { nextEligibleTime: number }) {
  const [remaining, setRemaining] = useState(0);

  useEffect(() => {
    function update() {
      setRemaining(Math.max(0, Math.ceil((nextEligibleTime - Date.now()) / 1000)));
    }
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [nextEligibleTime]);

  if (remaining <= 0) return null;
  return (
    <span className="text-sm text-sunset-600 font-mono">
      Cooldown: {remaining}s
    </span>
  );
}

export function PostBlobbleButton() {
  const queryClient = useQueryClient();
  const [result, setResult] = useState<{ txHash: string; messageCount: number } | null>(null);

  const { data: pendingCount = 0 } = useQuery({
    queryKey: ['pendingCount'],
    queryFn: fetchPendingCount,
    refetchInterval: 5000,
  });

  const { data: posterStatus } = useQuery({
    queryKey: ['posterStatus'],
    queryFn: fetchPosterStatus,
    refetchInterval: 5000,
  });

  const mutation = useMutation({
    mutationFn: postBlobble,
    onSuccess: (data) => {
      setResult(data);
      queryClient.invalidateQueries({ queryKey: ['messages'] });
      queryClient.invalidateQueries({ queryKey: ['pendingCount'] });
      queryClient.invalidateQueries({ queryKey: ['blobbles'] });
      queryClient.invalidateQueries({ queryKey: ['posterStatus'] });
    },
  });

  const inCooldown = posterStatus ? !posterStatus.canPostNow : false;
  const canPost = pendingCount > 0 && !mutation.isPending && !inCooldown;

  if (pendingCount === 0 && !result && !posterStatus) return null;

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
        <div className="flex flex-col items-end gap-1">
          <button
            onClick={() => mutation.mutate()}
            disabled={!canPost}
            className="btn-primary"
          >
            {mutation.isPending ? 'Posting...' : inCooldown ? 'Cooling down...' : 'Post Blobble'}
          </button>
          {posterStatus?.nextEligibleTime && !posterStatus.canPostNow && (
            <CooldownTimer nextEligibleTime={posterStatus.nextEligibleTime} />
          )}
        </div>
      </div>

      {posterStatus && (
        <div className="mt-4 p-3 bg-ocean-50 border border-ocean-200 rounded-lg text-sm space-y-1">
          <div className="flex justify-between">
            <span className="text-ocean-600">Signer</span>
            <span className="font-mono text-ocean-800 text-xs">
              {posterStatus.address}
            </span>
          </div>
          {posterStatus.balance !== null && (
            <div className="flex justify-between">
              <span className="text-ocean-600">Balance</span>
              <span className={`font-mono ${parseFloat(posterStatus.balance) < 0.01 ? 'text-red-600 font-bold' : 'text-ocean-800'}`}>
                {parseFloat(posterStatus.balance).toFixed(6)} ETH
              </span>
            </div>
          )}
          {posterStatus.lastPostTime && (
            <div className="flex justify-between">
              <span className="text-ocean-600">Last posted</span>
              <span className="text-ocean-800">
                {new Date(posterStatus.lastPostTime).toLocaleTimeString()}
              </span>
            </div>
          )}
        </div>
      )}

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
