import type { Bytes32 } from 'bam-sdk';

import type { PanelKind, PanelResult } from './panel-result';

const HEX_BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;

export function isHex32(s: string): boolean {
  return HEX_BYTES32_RE.test(s);
}

/**
 * Truncate a long string for display. Non-strings render as the
 * empty string so panels can pass `unknown`-typed row fields
 * straight in.
 */
export function shortOrEmpty(v: unknown): string {
  if (typeof v !== 'string') return '';
  if (v.length <= 12) return v;
  return `${v.slice(0, 6)}…${v.slice(-4)}`;
}

/**
 * Pull `data[key]` if it's an array; otherwise return `[]`. Used by
 * panels to defensively read upstream JSON shapes without making
 * each panel re-implement the same shape check.
 */
export function arrayField<T>(data: unknown, key: string): T[] {
  if (
    typeof data === 'object' &&
    data !== null &&
    key in data &&
    Array.isArray((data as Record<string, unknown>)[key])
  ) {
    return (data as Record<string, T[]>)[key];
  }
  return [];
}

/**
 * Roll up per-tag panel results into a single status badge for the
 * panel shell. Priority (worst → best): error > unreachable >
 * not_configured > ok. An empty map renders as `not_configured` —
 * which the reader-list panels use as the "no content tags" signal.
 */
export function aggregateKind(
  resultsByTag: Map<Bytes32, PanelResult<unknown>>
): PanelKind {
  if (resultsByTag.size === 0) return 'not_configured';
  let worst: PanelKind = 'ok';
  const rank: Record<PanelKind, number> = {
    ok: 0,
    not_configured: 1,
    unreachable: 2,
    error: 3,
  };
  for (const r of resultsByTag.values()) {
    if (rank[r.kind] > rank[worst]) worst = r.kind;
  }
  return worst;
}
