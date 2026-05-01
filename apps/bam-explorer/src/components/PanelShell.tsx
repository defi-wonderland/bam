import type { ReactNode } from 'react';

import { EndpointLabel } from './EndpointLabel';
import { StatusBadge } from './StatusBadge';
import type { PanelResult } from '../lib/panel-result';

export function PanelShell({
  title,
  endpoint,
  status,
  children,
}: {
  title: string;
  endpoint: string;
  status: PanelResult<unknown>['kind'];
  children: ReactNode;
}) {
  return (
    <section className="bg-white rounded-lg ring-1 ring-slate-200 p-4 flex flex-col gap-3">
      <header className="flex items-baseline justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
          <EndpointLabel endpoint={endpoint} />
        </div>
        <StatusBadge kind={status} />
      </header>
      <div className="text-sm text-slate-700">{children}</div>
    </section>
  );
}
