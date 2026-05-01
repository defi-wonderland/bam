import type { ReactNode } from 'react';

import { EndpointLabel } from './EndpointLabel';
import { StatusBadge } from './StatusBadge';
import type { PanelResult } from '../lib/panel-result';

export function PanelShell({
  title,
  endpoint,
  status,
  overridden,
  children,
}: {
  title: string;
  endpoint: string;
  status: PanelResult<unknown>['kind'];
  /**
   * `true` when the upstream URL for this panel differs from the
   * build-time `NEXT_PUBLIC_DEFAULT_*` default. Surfaces a small
   * "override" pill next to the endpoint label so a viewer can see
   * when the displayed data is from a non-default URL.
   */
  overridden?: boolean;
  children: ReactNode;
}) {
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
        <StatusBadge kind={status} />
      </header>
      <div className="text-sm text-slate-700">{children}</div>
    </section>
  );
}
