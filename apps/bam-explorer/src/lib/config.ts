/**
 * Server-side env parsing for the Explorer.
 *
 * Two operator-facing knobs live here:
 *   - `EXPLORER_CONTENT_TAGS` — comma-separated `0x`-prefixed bytes32
 *     content tags. Reader-list panels render one row group per tag.
 *     If empty/unset, those panels render the "no content tags
 *     configured" state; the rest of the page still works.
 *   - `EXPLORER_{PENDING,SUBMITTED,BATCHES,MESSAGES}_LIMIT` — per-panel
 *     page size, default 50, clamped to `[1, 200]`. A malformed or
 *     out-of-range value falls back to the default with a single
 *     `console.warn` at boot.
 */

import type { Bytes32 } from 'bam-sdk';

const HEX_BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;

const DEFAULT_LIMIT = 50;
const LIMIT_MIN = 1;
const LIMIT_MAX = 200;

export type PanelLimitName = 'pending' | 'submitted' | 'batches' | 'messages';

const ENV_BY_PANEL: Record<PanelLimitName, string> = {
  pending: 'EXPLORER_PENDING_LIMIT',
  submitted: 'EXPLORER_SUBMITTED_LIMIT',
  batches: 'EXPLORER_BATCHES_LIMIT',
  messages: 'EXPLORER_MESSAGES_LIMIT',
};

export function readContentTags(rawEnv?: string): Bytes32[] {
  const raw = rawEnv ?? process.env.EXPLORER_CONTENT_TAGS;
  if (raw === undefined || raw.trim().length === 0) return [];
  const parts = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  const out: Bytes32[] = [];
  for (const p of parts) {
    if (HEX_BYTES32_RE.test(p)) {
      out.push(p as Bytes32);
    } else {
      console.warn(`[bam-explorer] dropping invalid EXPLORER_CONTENT_TAGS entry: ${p}`);
    }
  }
  return out;
}

export function readPanelLimit(name: PanelLimitName, rawEnv?: string): number {
  const envName = ENV_BY_PANEL[name];
  const raw = rawEnv ?? process.env[envName];
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_LIMIT;
  if (!/^\d+$/.test(raw.trim())) {
    console.warn(`[bam-explorer] ${envName}=${raw} is not numeric, falling back to ${DEFAULT_LIMIT}`);
    return DEFAULT_LIMIT;
  }
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n < LIMIT_MIN || n > LIMIT_MAX) {
    console.warn(`[bam-explorer] ${envName}=${raw} is out of range [${LIMIT_MIN}, ${LIMIT_MAX}], falling back to ${DEFAULT_LIMIT}`);
    return DEFAULT_LIMIT;
  }
  return n;
}
