import type { PanelResult } from '../lib/panel-result';
import { SimplePanel } from './PanelShell';

export function PosterStatusPanel({
  result,
  overridden,
  onRefresh,
}: {
  result: PanelResult<unknown>;
  overridden?: boolean;
  onRefresh?: () => void | Promise<void>;
}) {
  return (
    <SimplePanel
      title="Poster status"
      endpoint="Poster GET /status"
      result={result}
      overridden={overridden}
      onRefresh={onRefresh}
      renderOk={(data) => (
        <pre
          data-testid="poster-status-ok"
          className="text-xs bg-slate-50 rounded p-2 overflow-x-auto text-slate-700"
        >
          {JSON.stringify(extractStatus(data), null, 2)}
        </pre>
      )}
    />
  );
}

function extractStatus(data: unknown): unknown {
  if (typeof data === 'object' && data !== null && 'status' in data) {
    return (data as { status: unknown }).status;
  }
  return data;
}
