'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';

interface SyncCheck {
  onChainCount: number;
  knownCount: number;
  missingCount: number;
  missing: Array<{ txHash: string; blockNumber: number; submitter: string }>;
}

interface SyncResultItem {
  txHash: string;
  status: 'synced' | 'blob_unavailable' | 'error';
  messageCount?: number;
  error?: string;
}

interface SyncResult {
  synced: number;
  totalMessages: number;
  results: SyncResultItem[];
}

async function fetchSyncStatus(): Promise<SyncCheck> {
  const res = await fetch('/api/sync');
  if (!res.ok) throw new Error('Failed to check sync status');
  return res.json();
}

async function runSync(): Promise<SyncResult> {
  const res = await fetch('/api/sync', { method: 'POST' });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || 'Sync failed');
  }
  return res.json();
}

export function SyncStatus() {
  const queryClient = useQueryClient();
  const [lastResult, setLastResult] = useState<SyncResult | null>(null);

  const { data: status, isLoading } = useQuery({
    queryKey: ['syncStatus'],
    queryFn: fetchSyncStatus,
    refetchInterval: 30000,
  });

  const mutation = useMutation({
    mutationFn: runSync,
    onSuccess: (data) => {
      setLastResult(data);
      queryClient.invalidateQueries({ queryKey: ['syncStatus'] });
      queryClient.invalidateQueries({ queryKey: ['messages'] });
      queryClient.invalidateQueries({ queryKey: ['blobbles'] });
    },
  });

  // Auto-sync when the poller detects a missing blobble. Debounced
  // at 30s so a permanently-unavailable blob (pruned past ~18 days,
  // or RPC that can't serve blob data) doesn't hot-loop.
  const lastAutoSyncAt = useRef<number>(0);
  useEffect(() => {
    if (!status) return;
    if (status.missingCount === 0) return;
    if (mutation.isPending) return;
    const now = Date.now();
    if (now - lastAutoSyncAt.current < 30_000) return;
    lastAutoSyncAt.current = now;
    mutation.mutate();
  }, [status, mutation]);

  if (isLoading) return null;

  return (
    <div className="card mb-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-bold text-ocean-700">Chain Sync</h3>
          <p className="text-sm text-ocean-500">
            {status && status.missingCount > 0
              ? `${status.missingCount} on-chain blobble${status.missingCount !== 1 ? 's' : ''} not in database`
              : 'Database is in sync with on-chain data'}
          </p>
        </div>
        <button
          onClick={() => mutation.mutate()}
          disabled={!status || status.missingCount === 0 || mutation.isPending}
          className="btn-primary"
        >
          {mutation.isPending ? 'Syncing...' : 'Sync'}
        </button>
      </div>

      {status && (
        <div className="mt-3 text-xs text-ocean-500 flex gap-4">
          <span>On-chain: {status.onChainCount}</span>
          <span>In DB: {status.knownCount}</span>
          <span>Missing: {status.missingCount}</span>
        </div>
      )}

      {lastResult && (
        <div className="mt-4 p-3 bg-palm-50 border border-palm-200 rounded-lg text-sm">
          <p className="text-palm-800 font-bold">
            Synced {lastResult.synced} blobble{lastResult.synced !== 1 ? 's' : ''} ({lastResult.totalMessages} messages)
          </p>
          {lastResult.results.some((r) => r.status !== 'synced') && (
            <ul className="mt-2 space-y-1">
              {lastResult.results
                .filter((r) => r.status !== 'synced')
                .map((r) => (
                  <li key={r.txHash} className="text-xs">
                    <span className={r.status === 'error' ? 'text-red-600' : 'text-sunset-600'}>
                      {r.status === 'blob_unavailable' ? 'Blob pruned' : r.error}
                    </span>
                    {' '}
                    <span className="font-mono text-ocean-400">
                      {r.txHash.slice(0, 10)}...
                    </span>
                  </li>
                ))}
            </ul>
          )}
        </div>
      )}

      {mutation.isError && (
        <p className="text-red-500 text-sm mt-3">
          {mutation.error instanceof Error ? mutation.error.message : 'Sync failed'}
        </p>
      )}
    </div>
  );
}
