import type { Bytes32 } from 'bam-sdk';
import { hexToBytes } from 'bam-sdk/browser';

import type { PanelResult } from '../lib/panel-result';
import { aggregateKind, arrayField, shortOrEmpty } from '../lib/panel-helpers';
import { DegradedBody } from './DegradedBody';
import { PanelShell } from './PanelShell';
import { StatusBadge } from './StatusBadge';

interface MessageItem {
  messageHash?: string;
  sender?: string;
  batchRef?: string;
  contents?: string;
  status?: string;
  [key: string]: unknown;
}

export function ReaderMessagesPanel({
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
      title="Confirmed messages"
      endpoint="Reader GET /messages"
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
    <div className="rounded ring-1 ring-slate-100 p-2" data-testid="reader-messages-tag-section">
      <div className="flex items-baseline justify-between mb-2">
        <span className="font-mono text-xs text-slate-700">tag {shortOrEmpty(tag)}</span>
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
  const items = arrayField<MessageItem>(data, 'messages');
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
            <th className="text-left font-normal pr-3">sender</th>
            <th className="text-left font-normal pr-3">batchRef</th>
            <th className="text-left font-normal">text</th>
          </tr>
        </thead>
        <tbody>
          {items.map((m, i) => {
            const text = decodeText(m.contents);
            return (
              <tr key={String(m.messageHash ?? i)} className="text-slate-800">
                <td className="pr-3 truncate max-w-[16ch]">{shortOrEmpty(m.messageHash)}</td>
                <td className="pr-3 truncate max-w-[14ch]">{shortOrEmpty(m.sender)}</td>
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

const utf8 = new TextDecoder('utf-8', { fatal: true });

// Reader rows can carry up to a full blob (~128 KB), but every
// codec in this repo fits well under 16 KB. With up to 200
// decoded rows per render the cap keeps the renderer responsive
// even for adversarial payloads. The check on `contents.length`
// runs before any allocation.
const MAX_CONTENTS_BYTES = 16_384;
const MAX_CONTENTS_HEX_CHARS = MAX_CONTENTS_BYTES * 2;

/**
 * Best-effort decode of a BAM message's `contents` into UTF-8 text.
 * After the tag-binding rework, `contents` carries the app body
 * directly — `contentTag` is bound into the signed digest, not
 * prepended. Each app's codec ends in `[u32 BE length][utf8]`, so we
 * scan for the offset whose trailing bytes form a valid
 * length-prefixed UTF-8 string. Returns null if no candidate fits.
 *
 * Exported for test/decode-text.test.ts; not part of the panel's
 * public API.
 */
export function decodeText(contents: unknown): string | null {
  if (typeof contents !== 'string' || !contents.startsWith('0x')) return null;
  if (contents.length > MAX_CONTENTS_HEX_CHARS + 2) return null;
  let bytes: Uint8Array;
  try {
    bytes = hexToBytes(contents);
  } catch {
    return null;
  }
  if (bytes.length < 4) return null;
  for (let p = 0; p + 4 <= bytes.length; p++) {
    const len =
      (bytes[p] * 0x1000000 + (bytes[p + 1] << 16) + (bytes[p + 2] << 8) + bytes[p + 3]) >>> 0;
    // `len === 0` is valid (empty UTF-8); cap at 4096 to bound work.
    if (len > 4096) continue;
    if (p + 4 + len !== bytes.length) continue;
    try {
      return utf8.decode(bytes.subarray(p + 4, p + 4 + len));
    } catch {
      // not valid UTF-8 at this offset; keep scanning
    }
  }
  return null;
}
