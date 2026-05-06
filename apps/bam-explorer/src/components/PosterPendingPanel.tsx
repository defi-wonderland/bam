import type { PanelResult } from '../lib/panel-result';
import { arrayField, shortOrEmpty } from '../lib/panel-helpers';
import { SimplePanel } from './PanelShell';

interface PendingItem {
  messageHash?: string;
  contentTag?: string;
  sender?: string;
  ingestedAt?: number;
  [key: string]: unknown;
}

export function PosterPendingPanel({
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
      title="Pending messages"
      endpoint="Poster GET /pending"
      result={result}
      overridden={overridden}
      onRefresh={onRefresh}
      renderOk={(data) => <PendingList data={data} />}
    />
  );
}

function PendingList({ data }: { data: unknown }) {
  const items = arrayField<PendingItem>(data, 'pending');
  if (items.length === 0) {
    return (
      <p data-testid="poster-pending-empty" className="text-slate-500">
        No pending messages.
      </p>
    );
  }
  return (
    <div data-testid="poster-pending-ok" className="overflow-x-auto">
      <p className="text-xs text-slate-500 mb-2">{items.length} pending</p>
      <table className="w-full text-xs font-mono">
        <thead className="text-slate-500">
          <tr>
            <th className="text-left font-normal pr-3">messageHash</th>
            <th className="text-left font-normal pr-3">sender</th>
            <th className="text-left font-normal pr-3">contentTag</th>
            <th className="text-left font-normal">ingestedAt</th>
          </tr>
        </thead>
        <tbody>
          {items.map((m, i) => (
            <tr key={String(m.messageHash ?? i)} className="text-slate-800">
              <td className="pr-3 truncate max-w-[16ch]">{shortOrEmpty(m.messageHash)}</td>
              <td className="pr-3 truncate max-w-[14ch]">{shortOrEmpty(m.sender)}</td>
              <td className="pr-3 truncate max-w-[14ch]">{shortOrEmpty(m.contentTag)}</td>
              <td className="whitespace-nowrap">{formatTs(m.ingestedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatTs(v: unknown): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '';
  return new Date(v).toLocaleString();
}
