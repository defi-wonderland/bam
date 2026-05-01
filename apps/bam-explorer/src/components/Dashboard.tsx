'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Bytes32 } from 'bam-sdk';

import {
  fetchPosterHealth,
  fetchPosterPending,
  fetchPosterStatus,
  fetchPosterSubmittedBatches,
  fetchReaderBatches,
  fetchReaderHealth,
  fetchReaderMessages,
} from '../lib/fetchers';
import { useExplorerConfig, type ExplorerConfig } from '../lib/client-config';
import type { PanelResult } from '../lib/panel-result';

import { Freshness } from './Freshness';
import { PosterHealthPanel } from './PosterHealthPanel';
import { PosterPendingPanel } from './PosterPendingPanel';
import { PosterStatusPanel } from './PosterStatusPanel';
import { PosterSubmittedBatchesPanel } from './PosterSubmittedBatchesPanel';
import { ReaderBatchesPanel } from './ReaderBatchesPanel';
import { ReaderHealthPanel } from './ReaderHealthPanel';
import { ReaderMessagesPanel } from './ReaderMessagesPanel';
import { SettingsPanel } from './SettingsPanel';

interface DashboardData {
  fetchedAt: number;
  posterHealth: PanelResult<unknown>;
  posterStatus: PanelResult<unknown>;
  posterPending: PanelResult<unknown>;
  posterSubmittedBatches: PanelResult<unknown>;
  readerHealth: PanelResult<unknown>;
  readerBatchesByTag: Map<Bytes32, PanelResult<unknown>>;
  readerMessagesByTag: Map<Bytes32, PanelResult<unknown>>;
}

async function loadDashboard(cfg: ExplorerConfig): Promise<DashboardData> {
  const fetchedAt = Date.now();
  const readerCfg = { baseUrl: cfg.readerUrl };
  const posterCfg = { baseUrl: cfg.posterUrl, authToken: cfg.posterAuthToken || undefined };

  const [
    posterHealth,
    posterStatus,
    posterPending,
    posterSubmittedBatches,
    readerHealth,
    readerBatchesEntries,
    readerMessagesEntries,
  ] = await Promise.all([
    fetchPosterHealth(posterCfg),
    fetchPosterStatus(posterCfg),
    fetchPosterPending(posterCfg, cfg.pendingLimit),
    fetchPosterSubmittedBatches(posterCfg, cfg.submittedLimit),
    fetchReaderHealth(readerCfg),
    Promise.all(
      cfg.contentTags.map(
        async (tag) => [tag, await fetchReaderBatches(readerCfg, tag, cfg.batchesLimit)] as const
      )
    ),
    Promise.all(
      cfg.contentTags.map(
        async (tag) => [tag, await fetchReaderMessages(readerCfg, tag, cfg.messagesLimit)] as const
      )
    ),
  ]);

  return {
    fetchedAt,
    posterHealth,
    posterStatus,
    posterPending,
    posterSubmittedBatches,
    readerHealth,
    readerBatchesByTag: new Map(readerBatchesEntries),
    readerMessagesByTag: new Map(readerMessagesEntries),
  };
}

export function Dashboard() {
  const cfg = useExplorerConfig();
  const [data, setData] = useState<DashboardData | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const d = await loadDashboard(cfg.config);
      setData(d);
    } finally {
      setRefreshing(false);
    }
  }, [cfg.config]);

  useEffect(() => {
    if (!cfg.mounted) return;
    void refresh();
    // Re-fetch when the config object changes (Settings applied / reset).
  }, [cfg.mounted, cfg.config, refresh]);

  if (!cfg.mounted) {
    return (
      <main className="max-w-6xl mx-auto px-6 py-8">
        <header className="flex items-baseline justify-between mb-6">
          <div>
            <h1 className="text-2xl font-semibold">BAM Explorer</h1>
            <p className="text-sm text-slate-600">Loading…</p>
          </div>
        </header>
      </main>
    );
  }

  const noTagsConfigured = cfg.config.contentTags.length === 0;

  return (
    <main className="max-w-6xl mx-auto px-6 py-8 relative">
      <header className="flex items-baseline justify-between mb-6 gap-4">
        <div>
          <h1 className="text-2xl font-semibold">BAM Explorer</h1>
          <p className="text-sm text-slate-600">
            Read-only view of a Reader + Poster pair. Data fetched directly
            from your browser.
          </p>
        </div>
        <div className="flex items-baseline gap-3">
          {data && <Freshness fetchedAt={data.fetchedAt} />}
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={refreshing}
            data-testid="refresh-button"
            className="text-sm font-medium text-slate-700 hover:text-slate-900 disabled:opacity-50 px-3 py-1 rounded ring-1 ring-slate-200 bg-white"
          >
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
          <SettingsPanel cfg={cfg} onApply={() => void refresh()} />
        </div>
      </header>

      {data === null ? (
        <p className="text-slate-500" data-testid="dashboard-loading">
          Loading panels…
        </p>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <PosterHealthPanel result={data.posterHealth} overridden={cfg.flags.posterUrl} />
            <ReaderHealthPanel result={data.readerHealth} overridden={cfg.flags.readerUrl} />
            <PosterStatusPanel result={data.posterStatus} overridden={cfg.flags.posterUrl} />
            <PosterPendingPanel result={data.posterPending} overridden={cfg.flags.posterUrl} />
            <PosterSubmittedBatchesPanel
              result={data.posterSubmittedBatches}
              overridden={cfg.flags.posterUrl}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 mt-4">
            <ReaderBatchesPanel
              resultsByTag={data.readerBatchesByTag}
              noTagsConfigured={noTagsConfigured}
              overridden={cfg.flags.readerUrl}
            />
            <ReaderMessagesPanel
              resultsByTag={data.readerMessagesByTag}
              noTagsConfigured={noTagsConfigured}
              overridden={cfg.flags.readerUrl}
            />
          </div>
        </>
      )}
    </main>
  );
}
