import type { PanelResult } from '../lib/panel-result';
import { arrayField, shortOrEmpty } from '../lib/panel-helpers';
import { SimplePanel } from './PanelShell';

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
    <SimplePanel
      title="Submitted batches"
      endpoint="Poster GET /submitted-batches"
      result={result}
      overridden={overridden}
      onRefresh={onRefresh}
      renderOk={(data) => <SubmittedList data={data} />}
    />
  );
}

function SubmittedList({ data }: { data: unknown }) {
  const items = arrayField<BatchItem>(data, 'batches');
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
          {items.map((b, i) => (
            <tr
              key={`${String(b.txHash ?? '')}:${String(b.contentTag ?? '')}:${i}`}
              className="text-slate-800"
            >
              <td className="pr-3 truncate max-w-[16ch]">{shortOrEmpty(b.txHash)}</td>
              <td className="pr-3 text-right">{String(b.blockNumber ?? '')}</td>
              <td className="truncate max-w-[14ch]">{shortOrEmpty(b.contentTag)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
