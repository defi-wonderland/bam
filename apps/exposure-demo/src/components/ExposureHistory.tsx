'use client';

import { useQuery } from '@tanstack/react-query';

interface Exposure {
  contentHash: string;
  messageId: string;
  author: string;
  exposer: string;
  timestamp: number;
  txHash: string;
  blockNumber: number;
}

export function ExposureHistory() {
  const { data, isLoading } = useQuery<{ exposures: Exposure[] }>({
    queryKey: ['exposures'],
    queryFn: async () => {
      const res = await fetch('/api/exposures');
      return res.json();
    },
    refetchInterval: 15_000,
  });

  const exposures = data?.exposures ?? [];

  return (
    <div className="card">
      <h2 className="text-lg font-semibold mb-3">
        Step 5: Exposure History {!isLoading && `(${exposures.length})`}
      </h2>

      {isLoading && <p className="text-sm text-slate-400">Loading exposures...</p>}

      {exposures.length === 0 && !isLoading && (
        <p className="text-sm text-slate-400">
          No exposed messages yet. Expose a message from a blob above.
        </p>
      )}

      <div className="space-y-2">
        {exposures.map((e) => (
          <div
            key={e.txHash}
            className="rounded-lg border border-emerald-800/30 bg-emerald-900/10 p-3"
          >
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2">
                <span className="status-badge bg-emerald-900/50 text-emerald-300">
                  Exposed
                </span>
                <span className="status-badge bg-indigo-900/50 text-indigo-300">
                  Block {e.blockNumber}
                </span>
              </div>
              <span className="text-xs text-slate-500">
                {new Date(e.timestamp * 1000).toLocaleString()}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2 mt-2">
              <div>
                <span className="text-xs text-slate-500">Author</span>
                <p className="mono">{e.author.slice(0, 10)}...{e.author.slice(-6)}</p>
              </div>
              <div>
                <span className="text-xs text-slate-500">Exposer</span>
                <p className="mono">{e.exposer.slice(0, 10)}...{e.exposer.slice(-6)}</p>
              </div>
              <div>
                <span className="text-xs text-slate-500">Message ID</span>
                <p className="mono">{e.messageId.slice(0, 18)}...</p>
              </div>
              <div>
                <span className="text-xs text-slate-500">Content Hash (Blob)</span>
                <p className="mono">{e.contentHash.slice(0, 18)}...</p>
              </div>
            </div>

            <a
              href={`https://sepolia.etherscan.io/tx/${e.txHash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="mono text-indigo-400 hover:text-indigo-300 underline mt-2 inline-block"
            >
              View tx: {e.txHash.slice(0, 18)}...
            </a>
          </div>
        ))}
      </div>
    </div>
  );
}
