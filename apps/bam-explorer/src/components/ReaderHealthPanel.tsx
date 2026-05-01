import type { PanelResult } from '../lib/panel-result';
import { DegradedBody } from './DegradedBody';
import { PanelShell } from './PanelShell';

export function ReaderHealthPanel({ result }: { result: PanelResult<unknown> }) {
  return (
    <PanelShell title="Reader health" endpoint="Reader GET /health" status={result.kind}>
      {result.kind === 'ok' ? (
        <pre
          data-testid="reader-health-ok"
          className="text-xs bg-slate-50 rounded p-2 overflow-x-auto text-slate-700"
        >
          {JSON.stringify(result.data, null, 2)}
        </pre>
      ) : (
        <DegradedBody result={result} />
      )}
    </PanelShell>
  );
}
