'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { fetchReaderBatchByTxHash } from '../lib/fetchers';
import { useExplorerConfig } from '../lib/client-config';
import { isHex32 } from '../lib/panel-helpers';

import { BatchDetailCard, type BatchDetailState } from './BatchDetailCard';
import { Freshness } from './Freshness';

export function BatchDetailView({ txHash }: { txHash: string }) {
  const cfg = useExplorerConfig();
  const [state, setState] = useState<BatchDetailState | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number>(() => Date.now());

  useEffect(() => {
    if (!cfg.mounted) return;
    const now = Date.now();
    setFetchedAt(now);
    if (!isHex32(txHash)) {
      setState({ kind: 'malformed', fetchedAt: now });
      return;
    }
    let cancelled = false;
    void (async () => {
      const r = await fetchReaderBatchByTxHash({ baseUrl: cfg.config.readerUrl }, txHash);
      if (!cancelled) {
        setState(r as BatchDetailState);
        setFetchedAt(Date.now());
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cfg.mounted, cfg.config.readerUrl, txHash]);

  return (
    <main className="max-w-4xl mx-auto px-6 py-8">
      <header className="flex items-baseline justify-between mb-6">
        <div>
          <Link href="/" className="text-xs text-slate-500 hover:underline">
            ← back to dashboard
          </Link>
          <h1 className="text-2xl font-semibold mt-1">Batch detail</h1>
          <p className="font-mono text-xs text-slate-600 mt-1">{txHash}</p>
        </div>
        <Freshness fetchedAt={fetchedAt} />
      </header>

      {state === null ? (
        <p className="text-slate-500" data-testid="batch-detail-loading">
          Loading…
        </p>
      ) : (
        <BatchDetailCard txHash={txHash} state={state} />
      )}
    </main>
  );
}
