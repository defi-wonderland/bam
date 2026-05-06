import type { PanelResult } from '../lib/panel-result';
import { DegradedBody } from './DegradedBody';
import { PanelShell } from './PanelShell';

export type BatchDetailState =
  | PanelResult<unknown>
  | { kind: 'not_found'; fetchedAt: number }
  | { kind: 'malformed'; fetchedAt: number };

export function BatchDetailCard({
  txHash,
  state,
}: {
  txHash: string;
  state: BatchDetailState;
}) {
  const status = state.kind === 'ok' ? 'ok' : state.kind === 'not_configured' || state.kind === 'unreachable' || state.kind === 'error' ? state.kind : 'error';

  return (
    <PanelShell
      title="Batch detail"
      endpoint={`Reader GET /batches/${txHash}`}
      status={status}
    >
      {renderBody(state)}
    </PanelShell>
  );
}

function renderBody(state: BatchDetailState) {
  if (state.kind === 'ok') {
    return (
      <pre
        data-testid="batch-detail-ok"
        className="text-xs bg-slate-50 rounded p-2 overflow-x-auto text-slate-700"
      >
        {JSON.stringify(extractBatch(state.data), null, 2)}
      </pre>
    );
  }
  if (state.kind === 'not_found') {
    return (
      <p data-testid="batch-detail-not-found" className="text-slate-600">
        No batch matches this transaction hash.
      </p>
    );
  }
  if (state.kind === 'malformed') {
    return (
      <p data-testid="batch-detail-malformed" className="text-rose-700">
        Malformed transaction hash. Expected a 0x-prefixed 32-byte hex string.
      </p>
    );
  }
  return <DegradedBody result={state} />;
}

function extractBatch(data: unknown): unknown {
  if (typeof data === 'object' && data !== null && 'batch' in data) {
    return (data as { batch: unknown }).batch;
  }
  return data;
}
