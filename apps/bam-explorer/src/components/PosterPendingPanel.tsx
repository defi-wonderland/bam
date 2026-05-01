import type { PanelResult } from '../lib/panel-result';
import { DegradedBody } from './DegradedBody';
import { PanelShell } from './PanelShell';

interface PendingItem {
  messageHash?: string;
  contentTag?: string;
  author?: string;
  receivedAt?: string | number;
  [key: string]: unknown;
}

export function PosterPendingPanel({ result }: { result: PanelResult<unknown> }) {
  return (
    <PanelShell
      title="Pending messages"
      endpoint="Poster GET /pending"
      status={result.kind}
    >
      {result.kind === 'ok' ? (
        <PendingList data={result.data} />
      ) : (
        <DegradedBody result={result} />
      )}
    </PanelShell>
  );
}

function PendingList({ data }: { data: unknown }) {
  const items = extractPending(data);
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
            <th className="text-left font-normal pr-3">author</th>
            <th className="text-left font-normal">contentTag</th>
          </tr>
        </thead>
        <tbody>
          {items.slice(0, 50).map((m, i) => (
            <tr key={String(m.messageHash ?? i)} className="text-slate-800">
              <td className="pr-3 truncate max-w-[16ch]">{short(m.messageHash)}</td>
              <td className="pr-3 truncate max-w-[14ch]">{short(m.author)}</td>
              <td className="truncate max-w-[14ch]">{short(m.contentTag)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function extractPending(data: unknown): PendingItem[] {
  if (
    typeof data === 'object' &&
    data !== null &&
    'pending' in data &&
    Array.isArray((data as { pending: unknown }).pending)
  ) {
    return (data as { pending: PendingItem[] }).pending;
  }
  return [];
}

function short(v: unknown): string {
  if (typeof v !== 'string') return '';
  if (v.length <= 12) return v;
  return `${v.slice(0, 6)}…${v.slice(-4)}`;
}
