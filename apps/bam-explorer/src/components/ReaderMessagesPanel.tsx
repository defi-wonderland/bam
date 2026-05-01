import type { Bytes32 } from 'bam-sdk';

import type { PanelResult } from '../lib/panel-result';
import { DegradedBody } from './DegradedBody';
import { PanelShell } from './PanelShell';
import { StatusBadge } from './StatusBadge';
import { aggregateKind, short } from '../lib/panel-helpers';

interface MessageItem {
  messageHash?: string;
  author?: string;
  batchRef?: string;
  contents?: string;
  status?: string;
  [key: string]: unknown;
}

export function ReaderMessagesPanel({
  resultsByTag,
  noTagsConfigured,
  overridden,
  onRefresh,
}: {
  resultsByTag: Map<Bytes32, PanelResult<unknown>>;
  noTagsConfigured: boolean;
  overridden?: boolean;
  onRefresh?: () => void | Promise<void>;
}) {
  const overallKind = noTagsConfigured ? 'not_configured' : aggregateKind(resultsByTag);

  return (
    <PanelShell
      title="Confirmed messages"
      endpoint="Reader GET /messages"
      status={overallKind}
      overridden={overridden}
      onRefresh={onRefresh}
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
            <th className="text-left font-normal pr-3">batchRef</th>
            <th className="text-left font-normal">text</th>
          </tr>
        </thead>
        <tbody>
          {items.slice(0, 50).map((m, i) => {
            const text = decodeText(m.contents);
            return (
              <tr key={String(m.messageHash ?? i)} className="text-slate-800">
                <td className="pr-3 truncate max-w-[16ch]">{shortOrEmpty(m.messageHash)}</td>
                <td className="pr-3 truncate max-w-[14ch]">{shortOrEmpty(m.author)}</td>
                <td className="pr-3 truncate max-w-[16ch]">{shortOrEmpty(m.batchRef)}</td>
                <td
                  className={`truncate max-w-[40ch] font-sans ${text === null ? 'text-slate-400 italic' : ''}`}
                  title={text ?? '(undecoded)'}
                >
                  {text ?? '(undecoded)'}
                </td>
              </tr>
            );
          })}
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

const utf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Best-effort decode of a BAM message's `contents` hex string into UTF-8 text.
 *
 * Each app on top of BAM owns its own `contents[32:]` codec (see
 * `apps/bam-twitter/src/lib/contents-codec.ts` and
 * `apps/message-in-a-blobble/src/lib/contents-codec.ts`). They all end with
 * `[u32 BE length][length bytes UTF-8]`, so we scan for the smallest offset
 * where the trailing bytes form a valid length-prefixed UTF-8 string.
 * Returns null if no candidate fits.
 */
function decodeText(contents: unknown): string | null {
  if (typeof contents !== 'string' || !contents.startsWith('0x')) return null;
  const hex = contents.slice(2);
  if (hex.length % 2 !== 0) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  if (bytes.length < 32 + 4) return null;
  const app = bytes.subarray(32);
  for (let p = 0; p + 4 <= app.length; p++) {
    const len =
      (app[p] * 0x1000000 + (app[p + 1] << 16) + (app[p + 2] << 8) + app[p + 3]) >>> 0;
    if (len === 0 || len > 4096) continue;
    if (p + 4 + len !== app.length) continue;
    try {
      return utf8.decode(app.subarray(p + 4, p + 4 + len));
    } catch {
      // not valid UTF-8 at this offset; keep scanning
    }
  }
  return null;
}
