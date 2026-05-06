import type { PanelResult } from '../lib/panel-result';
import { SimplePanel } from './PanelShell';

export function ReaderHealthPanel({
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
      title="Reader health"
      endpoint="Reader GET /health"
      result={result}
      overridden={overridden}
      onRefresh={onRefresh}
      renderOk={(data) => (
        <pre
          data-testid="reader-health-ok"
          className="text-xs bg-slate-50 rounded p-2 overflow-x-auto text-slate-700"
        >
          {JSON.stringify(data, null, 2)}
        </pre>
      )}
    />
  );
}
