import { useState, type ReactNode } from 'react';

import { DegradedBody } from './DegradedBody';
import { EndpointLabel } from './EndpointLabel';
import { StatusBadge } from './StatusBadge';
import type { PanelKind, PanelResult } from '../lib/panel-result';

export interface PanelShellBaseProps {
  title: string;
  endpoint: string;
  /**
   * `true` when the upstream URL for this panel differs from the
   * build-time `NEXT_PUBLIC_DEFAULT_*` default. Surfaces a small
   * "override" pill next to the endpoint label so a viewer can see
   * when the displayed data is from a non-default URL.
   */
  overridden?: boolean;
  onRefresh?: () => void | Promise<void>;
}

export function PanelShell({
  title,
  endpoint,
  status,
  overridden,
  onRefresh,
  children,
}: PanelShellBaseProps & {
  status: PanelKind;
  children: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const handleRefresh = async () => {
    if (!onRefresh || busy) return;
    setBusy(true);
    try {
      await onRefresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="bg-white rounded-lg ring-1 ring-slate-200 p-4 flex flex-col gap-3">
      <header className="flex items-baseline justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
          <div className="flex items-baseline gap-2">
            <EndpointLabel endpoint={endpoint} />
            {overridden && (
              <span
                data-testid="panel-override-flag"
                className="text-[10px] uppercase tracking-wide bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded"
              >
                override
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge kind={status} />
          {onRefresh && (
            <button
              type="button"
              onClick={() => void handleRefresh()}
              disabled={busy}
              aria-label={`Refresh ${title}`}
              title="Refresh"
              data-testid="panel-refresh-button"
              className="text-xs text-slate-600 hover:text-slate-900 disabled:opacity-50 px-1.5 py-0.5 rounded ring-1 ring-slate-200 bg-white"
            >
              {busy ? '…' : '↻'}
            </button>
          )}
        </div>
      </header>
      <div className="text-sm text-slate-700">{children}</div>
    </section>
  );
}

/**
 * Thin wrapper that handles the universal ok / degraded branch the
 * five "simple" panels (PosterHealth/Status/Pending/SubmittedBatches,
 * ReaderHealth) all share. Panels render their own ok body via
 * `renderOk`; everything else routes through `<DegradedBody>`.
 */
export function SimplePanel<T = unknown>({
  result,
  renderOk,
  ...shell
}: PanelShellBaseProps & {
  result: PanelResult<T>;
  renderOk: (data: T) => ReactNode;
}) {
  return (
    <PanelShell {...shell} status={result.kind}>
      {result.kind === 'ok' ? renderOk(result.data) : <DegradedBody result={result} />}
    </PanelShell>
  );
}
