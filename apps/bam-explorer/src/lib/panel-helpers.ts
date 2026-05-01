import type { Bytes32 } from 'bam-sdk';

import type { PanelResult } from './panel-result';

const HEX_BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;

export function isHex32(s: string): boolean {
  return HEX_BYTES32_RE.test(s);
}

export function short(s: string): string {
  if (s.length <= 12) return s;
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

/**
 * Roll up per-tag panel results into a single status badge for the
 * panel shell. Priority (worst → best): error > unreachable >
 * not_configured > ok. An empty map renders as `not_configured`.
 */
export function aggregateKind(
  resultsByTag: Map<Bytes32, PanelResult<unknown>>
): PanelResult<unknown>['kind'] {
  if (resultsByTag.size === 0) return 'not_configured';
  let worst: PanelResult<unknown>['kind'] = 'ok';
  const rank: Record<PanelResult<unknown>['kind'], number> = {
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
