import Link from 'next/link';
import type { Bytes32 } from 'bam-sdk';

import type { PanelResult } from '../lib/panel-result';
import { aggregateKind, arrayField, isHex32, shortOrEmpty } from '../lib/panel-helpers';
import { DegradedBody } from './DegradedBody';
import { PanelShell } from './PanelShell';
import { StatusBadge } from './StatusBadge';

interface BatchItem {
  txHash?: string;
  blockNumber?: string | number;
  status?: string;
  contentTag?: string;
  [key: string]: unknown;
}

export function ReaderBatchesPanel({
  resultsByTag,
  overridden,
  onRefresh,
}: {
  resultsByTag: Map<Bytes32, PanelResult<unknown>>;
  overridden?: boolean;
  onRefresh?: () => void | Promise<void>;
}) {
  const overallKind = aggregateKind(resultsByTag);

  return (
    <PanelShell
      title="Confirmed batches"
      endpoint="Reader GET /batches"
      status={overallKind}
      overridden={overridden}
      onRefresh={onRefresh}
    >
      {resultsByTag.size === 0 ? (
        <DegradedBody
          result={{ kind: 'not_configured', reason: 'no_content_tags', fetchedAt: 0 }}
        />
      ) : (
        <div className="flex flex-col gap-3">
          {Array.from(resultsByTag.entries()).map(([tag, result]) => (
            <TagSection key={tag} tag={tag} result={result} />
          ))}
        </div>
      )}
    </PanelShell>
  );
}

function TagSection({ tag, result }: { tag: Bytes32; result: PanelResult<unknown> }) {
  return (
    <div className="rounded ring-1 ring-slate-100 p-2" data-testid="reader-batches-tag-section">
      <div className="flex items-baseline justify-between mb-2">
        <span className="font-mono text-xs text-slate-700">tag {shortOrEmpty(tag)}</span>
        <StatusBadge kind={result.kind} />
      </div>
      {result.kind === 'ok' ? (
        <BatchesList data={result.data} />
      ) : (
        <DegradedBody result={result} />
      )}
    </div>
  );
}

function BatchesList({ data }: { data: unknown }) {
  const items = arrayField<BatchItem>(data, 'batches');
  if (items.length === 0) {
    return (
      <p data-testid="reader-batches-empty" className="text-slate-500 text-xs">
        No confirmed batches.
      </p>
    );
  }
  return (
    <div data-testid="reader-batches-ok" className="overflow-x-auto">
      <p className="text-xs text-slate-500 mb-1">{items.length} batches</p>
      <ul className="space-y-1">
        {items.map((b, i) => {
          const txHash = typeof b.txHash === 'string' ? b.txHash : null;
          const linkable = txHash !== null && isHex32(txHash);
          const display = (
            <span className="font-mono text-xs text-slate-800">
              {txHash ? shortOrEmpty(txHash) : '(no tx hash)'}
            </span>
          );
          return (
            <li key={String(b.txHash ?? i)} className="flex items-baseline gap-2">
              {linkable ? (
                <Link
                  href={`/batches/${txHash}`}
                  className="hover:underline"
                  data-testid="reader-batches-row-link"
                >
                  {display}
                </Link>
              ) : (
                display
              )}
              <span className="text-xs text-slate-500">
                block {String(b.blockNumber ?? '?')} · status {String(b.status ?? '?')}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
