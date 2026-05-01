/**
 * Build-time defaults + per-panel limit parsing.
 *
 * Defaults come from `NEXT_PUBLIC_DEFAULT_*` env baked into the bundle
 * by Next.js. Per-viewer overrides live in `localStorage` and are
 * managed by `useExplorerConfig` (`./client-config.ts`).
 *
 * **No token default.** A deployed Explorer never ships an operator's
 * Poster bearer token to anonymous visitors.
 */

import type { Bytes32 } from 'bam-sdk';

const HEX_BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;

const DEFAULT_LIMIT = 50;
const LIMIT_MIN = 1;
const LIMIT_MAX = 200;

export type PanelLimitName = 'pending' | 'submitted' | 'batches' | 'messages';

export interface DefaultsFromEnv {
  readerUrl: string;
  posterUrl: string;
  contentTags: Bytes32[];
}

export function parseContentTags(raw: string | undefined | null): Bytes32[] {
  if (raw === undefined || raw === null || raw.trim().length === 0) return [];
  const parts = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  const out: Bytes32[] = [];
  for (const p of parts) {
    if (HEX_BYTES32_RE.test(p)) {
      out.push(p as Bytes32);
    }
  }
  return out;
}

export function parsePanelLimit(raw: string | undefined | null): number {
  if (raw === undefined || raw === null || raw.trim().length === 0) return DEFAULT_LIMIT;
  if (!/^\d+$/.test(raw.trim())) return DEFAULT_LIMIT;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n < LIMIT_MIN || n > LIMIT_MAX) return DEFAULT_LIMIT;
  return n;
}

/**
 * Read the build-time defaults baked into the bundle. Safe on both
 * server and browser; `process.env.NEXT_PUBLIC_*` is inlined at
 * build time.
 */
export function readEnvDefaults(): DefaultsFromEnv {
  return {
    readerUrl: process.env.NEXT_PUBLIC_DEFAULT_READER_URL ?? '',
    posterUrl: process.env.NEXT_PUBLIC_DEFAULT_POSTER_URL ?? '',
    contentTags: parseContentTags(process.env.NEXT_PUBLIC_DEFAULT_CONTENT_TAGS),
  };
}
