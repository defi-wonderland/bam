import type { PanelResult } from '../lib/panel-result';
import { DegradedBody } from './DegradedBody';
import { PanelShell } from './PanelShell';

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
    <PanelShell
      title="Poster status"
      endpoint="Poster GET /status"
      status={result.kind}
      overridden={overridden}
      onRefresh={onRefresh}
    >
      {result.kind === 'ok' ? (
        <pre
          data-testid="poster-status-ok"
          className="text-xs bg-slate-50 rounded p-2 overflow-x-auto text-slate-700"
        >
          {JSON.stringify(extractStatus(result.data), null, 2)}
        </pre>
      ) : (
        <DegradedBody result={result} />
      )}
    </PanelShell>
  );
}

function extractStatus(data: unknown): unknown {
  if (typeof data === 'object' && data !== null && 'status' in data) {
    return (data as { status: unknown }).status;
  }
  return data;
}
