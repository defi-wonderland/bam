import type { PanelResult } from '../lib/panel-result';
import { DegradedBody } from './DegradedBody';
import { PanelShell } from './PanelShell';

export function PosterHealthPanel({ result }: { result: PanelResult<unknown> }) {
  return (
    <PanelShell title="Poster health" endpoint="Poster GET /health" status={result.kind}>
      {result.kind === 'ok' ? (
        <PosterHealthBody data={result.data} />
      ) : (
        <DegradedBody result={result} />
      )}
    </PanelShell>
  );
}

function PosterHealthBody({ data }: { data: unknown }) {
  const health =
    typeof data === 'object' && data !== null && 'health' in data
      ? (data as { health: unknown }).health
      : data;
  const state =
    typeof health === 'object' && health !== null && 'state' in health
      ? String((health as { state: unknown }).state)
      : 'unknown';
  return (
    <div data-testid="poster-health-ok" className="space-y-1">
      <div>
        <span className="text-slate-500">state: </span>
        <span className="font-mono text-slate-900">{state}</span>
      </div>
      <pre className="text-xs bg-slate-50 rounded p-2 overflow-x-auto text-slate-700">
        {JSON.stringify(health, null, 2)}
      </pre>
    </div>
  );
}
