'use client';

import { useState } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { MESSAGE_IN_A_BLOBBLE_TAG } from '@/lib/constants';

/**
 * Post-migration, the Poster submits autonomously — its per-tag
 * scheduler picks up messages once size/age/count triggers fire.
 * The "Post Blobble" button is now a *nudge* that calls the
 * `/flush` endpoint, which just triggers an immediate submission
 * tick rather than waiting for the next idle-poll. No cooldown UI
 * because batching is not rate-limited client-side anymore.
 */

interface PosterStatusBody {
  status: {
    walletAddress: string;
    walletBalanceWei: string; // bigint serialized as string
    configuredTags: string[];
    pendingByTag: Array<{ contentTag: string; count: number }>;
    lastSubmittedByTag: Array<{
      contentTag: string;
      txHash: string;
      blobVersionedHash: string;
      blockNumber: number | null;
      submittedAt: number;
    }>;
  };
}

interface PosterHealthBody {
  health: { state: 'ok' | 'degraded' | 'unhealthy'; reason?: string };
}

async function fetchPendingCount(): Promise<number> {
  const res = await fetch('/api/messages');
  if (!res.ok) return 0;
  const data = (await res.json()) as { pending?: unknown[] };
  return (data.pending ?? []).length;
}

async function fetchPosterStatus(): Promise<PosterStatusBody['status']> {
  const res = await fetch('/api/poster-status');
  if (!res.ok) throw new Error('Failed to fetch poster status');
  const data = (await res.json()) as PosterStatusBody;
  return data.status;
}

async function fetchPosterHealth(): Promise<PosterHealthBody['health']> {
  const res = await fetch('/api/poster-health');
  // Poster encodes `unhealthy` as HTTP 503 (with the same `{ health }`
  // body). Parse the body regardless of status so we actually render
  // the unhealthy state instead of treating it as a fetch failure.
  let data: PosterHealthBody | null = null;
  try {
    data = (await res.json()) as PosterHealthBody;
  } catch {
    // Not JSON — treat as a real network error below.
  }
  if (data?.health?.state) return data.health;
  throw new Error(`Poster health unavailable (HTTP ${res.status})`);
}

async function nudgeFlush(): Promise<{ flushed: string } | { error: string }> {
  const res = await fetch('/api/post-blobble', { method: 'POST' });
  const data = (await res.json()) as { flushed?: string; error?: string };
  if (!res.ok) throw new Error(data.error ?? 'flush failed');
  return data as { flushed: string };
}

function formatEth(wei: string): string {
  try {
    const w = BigInt(wei);
    // 6-decimal ETH; readable for Sepolia balances.
    const whole = w / 10n ** 18n;
    const frac = ((w % 10n ** 18n) * 10n ** 6n) / 10n ** 18n;
    return `${whole}.${frac.toString().padStart(6, '0')}`;
  } catch {
    return wei;
  }
}

export function PostBlobbleButton() {
  const queryClient = useQueryClient();
  const [flushedAt, setFlushedAt] = useState<number | null>(null);

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

  const { data: posterHealth } = useQuery({
    queryKey: ['posterHealth'],
    queryFn: fetchPosterHealth,
    refetchInterval: 5000,
  });

  const mutation = useMutation({
    mutationFn: nudgeFlush,
    onSuccess: () => {
      setFlushedAt(Date.now());
      queryClient.invalidateQueries({ queryKey: ['messages'] });
      queryClient.invalidateQueries({ queryKey: ['pendingCount'] });
      queryClient.invalidateQueries({ queryKey: ['posterStatus'] });
      // Nudge the on-chain audit view so a successful flush lands on
      // screen immediately rather than on the next 30 s poll.
      queryClient.invalidateQueries({ queryKey: ['blobbles'] });
    },
  });

  const unhealthy = posterHealth?.state === 'unhealthy';
  const canPost = pendingCount > 0 && !mutation.isPending && !unhealthy;
  // Filter by this demo's tag. The Poster can serve multiple tags per
  // process; `lastSubmittedByTag[0]` would surface an unrelated tx in a
  // multi-tag deployment. Lowercased on both sides because the Poster
  // canonicalizes tag casing at ingest.
  const lastTx = posterStatus?.lastSubmittedByTag?.find(
    (entry) => entry.contentTag.toLowerCase() === MESSAGE_IN_A_BLOBBLE_TAG.toLowerCase()
  );

  if (pendingCount === 0 && !lastTx && !posterStatus) return null;

  return (
    <div className="card mb-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-bold text-ocean-700">Post Blobble</h3>
          <p className="text-sm text-ocean-500">
            {pendingCount > 0
              ? `${pendingCount} message${pendingCount !== 1 ? 's' : ''} waiting for the next batch`
              : 'All messages posted!'}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <button
            onClick={() => mutation.mutate()}
            disabled={!canPost}
            className="btn-primary"
            title="The Poster batches autonomously; this just triggers an immediate tick."
          >
            {mutation.isPending ? 'Flushing...' : unhealthy ? 'Poster unhealthy' : 'Post Blobble now'}
          </button>
          {flushedAt !== null && (
            <span className="text-xs text-palm-600">
              Flush triggered {new Date(flushedAt).toLocaleTimeString()}
            </span>
          )}
        </div>
      </div>

      {posterStatus && (
        <div className="mt-4 p-3 bg-ocean-50 border border-ocean-200 rounded-lg text-sm space-y-1">
          <div className="flex justify-between">
            <span className="text-ocean-600">Signer</span>
            <span className="font-mono text-ocean-800 text-xs">
              {posterStatus.walletAddress}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-ocean-600">Balance</span>
            <span className={`font-mono ${parseFloat(formatEth(posterStatus.walletBalanceWei)) < 0.01 ? 'text-red-600 font-bold' : 'text-ocean-800'}`}>
              {formatEth(posterStatus.walletBalanceWei)} ETH
            </span>
          </div>
          {lastTx && (
            <>
              <div className="flex justify-between">
                <span className="text-ocean-600">Last batch</span>
                <span className="text-ocean-800 text-xs">
                  {new Date(lastTx.submittedAt).toLocaleTimeString()}
                </span>
              </div>
              <div className="flex justify-between items-center gap-2">
                <span className="text-ocean-600">Tx</span>
                <a
                  href={`https://sepolia.etherscan.io/tx/${lastTx.txHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-ocean-600 hover:text-ocean-800 text-xs underline"
                >
                  {lastTx.txHash.slice(0, 10)}…{lastTx.txHash.slice(-6)}
                </a>
              </div>
            </>
          )}
          {posterHealth && posterHealth.state !== 'ok' && (
            <div className="flex justify-between pt-2 mt-2 border-t border-ocean-200">
              <span className="text-ocean-600">Health</span>
              <span className={posterHealth.state === 'unhealthy' ? 'text-red-600 font-bold' : 'text-sunset-600'}>
                {posterHealth.state}
                {posterHealth.reason ? ` — ${posterHealth.reason}` : ''}
              </span>
            </div>
          )}
        </div>
      )}

      {mutation.isError && (
        <p className="text-red-500 text-sm mt-3">
          {mutation.error instanceof Error ? mutation.error.message : 'Failed to flush'}
        </p>
      )}
    </div>
  );
}
