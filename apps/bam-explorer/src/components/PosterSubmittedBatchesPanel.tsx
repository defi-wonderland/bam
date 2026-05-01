import type { PanelResult } from '../lib/panel-result';
import { DegradedBody } from './DegradedBody';
import { PanelShell } from './PanelShell';

interface BatchItem {
  txHash?: string;
  contentTag?: string;
  blockNumber?: string | number;
  status?: string;
  [key: string]: unknown;
}

export function PosterSubmittedBatchesPanel({
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
      title="Submitted batches"
      endpoint="Poster GET /submitted-batches"
      status={result.kind}
      overridden={overridden}
      onRefresh={onRefresh}
    >
      {result.kind === 'ok' ? (
        <SubmittedList data={result.data} />
      ) : (
        <DegradedBody result={result} />
      )}
    </PanelShell>
  );
}

function SubmittedList({ data }: { data: unknown }) {
  const items = extractBatches(data);
  if (items.length === 0) {
    return (
      <p data-testid="poster-submitted-empty" className="text-slate-500">
        No submitted batches.
      </p>
    );
  }
  return (
    <div data-testid="poster-submitted-ok" className="overflow-x-auto">
      <p className="text-xs text-slate-500 mb-2">{items.length} batches</p>
      <table className="w-full text-xs font-mono">
        <thead className="text-slate-500">
          <tr>
            <th className="text-left font-normal pr-3">txHash</th>
            <th className="text-left font-normal pr-3">block</th>
            <th className="text-left font-normal">contentTag</th>
          </tr>
        </thead>
        <tbody>
          {items.slice(0, 50).map((b, i) => (
            <tr key={`${String(b.txHash ?? '')}:${String(b.contentTag ?? '')}:${i}`} className="text-slate-800">
              <td className="pr-3 truncate max-w-[16ch]">{short(b.txHash)}</td>
              <td className="pr-3 text-right">{String(b.blockNumber ?? '')}</td>
              <td className="truncate max-w-[14ch]">{short(b.contentTag)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function extractBatches(data: unknown): BatchItem[] {
  if (
    typeof data === 'object' &&
    data !== null &&
    'batches' in data &&
    Array.isArray((data as { batches: unknown }).batches)
  ) {
    return (data as { batches: BatchItem[] }).batches;
  }
  return [];
}

function short(v: unknown): string {
  if (typeof v !== 'string') return '';
  if (v.length <= 12) return v;
  return `${v.slice(0, 6)}…${v.slice(-4)}`;
}
