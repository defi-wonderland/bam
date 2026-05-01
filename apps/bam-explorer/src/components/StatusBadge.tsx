import type { PanelResult } from '../lib/panel-result';

const LABEL_BY_KIND: Record<PanelResult<unknown>['kind'], string> = {
  ok: 'ok',
  not_configured: 'not configured',
  unreachable: 'unreachable',
  error: 'error',
};

const CLASS_BY_KIND: Record<PanelResult<unknown>['kind'], string> = {
  ok: 'bg-emerald-100 text-emerald-800 ring-emerald-200',
  not_configured: 'bg-slate-100 text-slate-700 ring-slate-200',
  unreachable: 'bg-amber-100 text-amber-800 ring-amber-200',
  error: 'bg-rose-100 text-rose-800 ring-rose-200',
};

export function StatusBadge({ kind }: { kind: PanelResult<unknown>['kind'] }) {
  const label = LABEL_BY_KIND[kind];
  return (
    <span
      role="status"
      aria-label={`status: ${label}`}
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ring-1 ${CLASS_BY_KIND[kind]}`}
    >
      {label}
    </span>
  );
}
