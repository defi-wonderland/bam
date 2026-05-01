import type { Bytes32 } from 'bam-sdk';

import type { PanelResult } from '../lib/panel-result';
import { DegradedBody } from './DegradedBody';
import { PanelShell } from './PanelShell';
import { StatusBadge } from './StatusBadge';
import { aggregateKind, short } from '../lib/panel-helpers';

interface MessageItem {
  messageHash?: string;
  author?: string;
  batchTxHash?: string;
  status?: string;
  [key: string]: unknown;
}

export function ReaderMessagesPanel({
  resultsByTag,
  noTagsConfigured,
}: {
  resultsByTag: Map<Bytes32, PanelResult<unknown>>;
  noTagsConfigured: boolean;
}) {
  const overallKind = noTagsConfigured ? 'not_configured' : aggregateKind(resultsByTag);

  return (
    <PanelShell
      title="Confirmed messages"
      endpoint="Reader GET /messages"
      status={overallKind}
    >
      {noTagsConfigured ? (
        <DegradedBody
          result={{
            kind: 'not_configured',
            reason: 'no_content_tags',
            fetchedAt: 0,
          }}
        />
      ) : (
        <PerTagSections resultsByTag={resultsByTag} />
      )}
    </PanelShell>
  );
}

function PerTagSections({
  resultsByTag,
}: {
  resultsByTag: Map<Bytes32, PanelResult<unknown>>;
}) {
  const entries = Array.from(resultsByTag.entries());
  return (
    <div className="flex flex-col gap-3">
      {entries.map(([tag, result]) => (
        <TagSection key={tag} tag={tag} result={result} />
      ))}
    </div>
  );
}

function TagSection({
  tag,
  result,
}: {
  tag: Bytes32;
  result: PanelResult<unknown>;
}) {
  return (
    <div className="rounded ring-1 ring-slate-100 p-2" data-testid="reader-messages-tag-section">
      <div className="flex items-baseline justify-between mb-2">
        <span className="font-mono text-xs text-slate-700">tag {short(tag)}</span>
        <StatusBadge kind={result.kind} />
      </div>
      {result.kind === 'ok' ? (
        <MessagesList data={result.data} />
      ) : (
        <DegradedBody result={result} />
      )}
    </div>
  );
}

function MessagesList({ data }: { data: unknown }) {
  const items = extract(data);
  if (items.length === 0) {
    return (
      <p data-testid="reader-messages-empty" className="text-slate-500 text-xs">
        No confirmed messages.
      </p>
    );
  }
  return (
    <div data-testid="reader-messages-ok" className="overflow-x-auto">
      <p className="text-xs text-slate-500 mb-1">{items.length} messages</p>
      <table className="w-full text-xs font-mono">
        <thead className="text-slate-500">
          <tr>
            <th className="text-left font-normal pr-3">messageHash</th>
            <th className="text-left font-normal pr-3">author</th>
            <th className="text-left font-normal">batchTxHash</th>
          </tr>
        </thead>
        <tbody>
          {items.slice(0, 50).map((m, i) => (
            <tr key={String(m.messageHash ?? i)} className="text-slate-800">
              <td className="pr-3 truncate max-w-[16ch]">{shortOrEmpty(m.messageHash)}</td>
              <td className="pr-3 truncate max-w-[14ch]">{shortOrEmpty(m.author)}</td>
              <td className="truncate max-w-[16ch]">{shortOrEmpty(m.batchTxHash)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function extract(data: unknown): MessageItem[] {
  if (
    typeof data === 'object' &&
    data !== null &&
    'messages' in data &&
    Array.isArray((data as { messages: unknown }).messages)
  ) {
    return (data as { messages: MessageItem[] }).messages;
  }
  return [];
}

function shortOrEmpty(v: unknown): string {
  if (typeof v !== 'string') return '';
  return short(v);
}
