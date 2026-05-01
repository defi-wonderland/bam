'use client';

/**
 * `useExplorerConfig` — React hook for the merged config:
 * `localStorage` overrides on top of `NEXT_PUBLIC_DEFAULT_*` build
 * defaults. Returns:
 *   - `mounted` — `false` during SSR / initial client render, `true`
 *     after `useEffect` reads `localStorage`. The Dashboard renders
 *     a loading shell while `!mounted` to keep SSR output
 *     deterministic and avoid a flash of default-URL data on
 *     viewers who have overrides.
 *   - `config` — effective `ExplorerConfig`.
 *   - `setOverride(key, value)` / `clearOverride(key)` /
 *     `resetAll()` for the Settings UI.
 *
 * The token has no env default (security posture in spec); it is
 * either entered via Settings or absent.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Bytes32 } from 'bam-sdk';

import {
  parseContentTags,
  parsePanelLimit,
  readEnvDefaults,
} from './config';

const STORAGE_KEY = 'bam-explorer.settings.v1';

export interface ExplorerConfig {
  readerUrl: string;
  posterUrl: string;
  posterAuthToken: string;
  contentTags: Bytes32[];
  pendingLimit: number;
  submittedLimit: number;
  batchesLimit: number;
  messagesLimit: number;
}

export interface OverrideFlags {
  readerUrl: boolean;
  posterUrl: boolean;
  posterAuthToken: boolean;
  contentTags: boolean;
  limits: boolean;
}

interface StoredOverrides {
  readerUrl?: string;
  posterUrl?: string;
  posterAuthToken?: string;
  contentTagsRaw?: string;
  pendingLimitRaw?: string;
  submittedLimitRaw?: string;
  batchesLimitRaw?: string;
  messagesLimitRaw?: string;
}

export type OverrideKey =
  | 'readerUrl'
  | 'posterUrl'
  | 'posterAuthToken'
  | 'contentTagsRaw'
  | 'pendingLimitRaw'
  | 'submittedLimitRaw'
  | 'batchesLimitRaw'
  | 'messagesLimitRaw';

function readStoredOverrides(): StoredOverrides {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return {};
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    return parsed as StoredOverrides;
  } catch {
    // Corrupt JSON — fall back to env defaults rather than crash.
    return {};
  }
}

function writeStoredOverrides(o: StoredOverrides): void {
  if (typeof window === 'undefined') return;
  // Strip empty-string fields so reading back yields "no override"
  // rather than "empty override" (which would clobber the env default
  // with a blank URL).
  const cleaned: StoredOverrides = {};
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === 'string' && v.length > 0) {
      (cleaned as Record<string, string>)[k] = v;
    }
  }
  if (Object.keys(cleaned).length === 0) {
    window.localStorage.removeItem(STORAGE_KEY);
  } else {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cleaned));
  }
}

function mergeConfig(overrides: StoredOverrides): {
  config: ExplorerConfig;
  flags: OverrideFlags;
} {
  const env = readEnvDefaults();

  const readerUrl = overrides.readerUrl ?? env.readerUrl;
  const posterUrl = overrides.posterUrl ?? env.posterUrl;
  const posterAuthToken = overrides.posterAuthToken ?? '';
  const contentTags =
    overrides.contentTagsRaw !== undefined
      ? parseContentTags(overrides.contentTagsRaw)
      : env.contentTags;
  const pendingLimit = parsePanelLimit(overrides.pendingLimitRaw);
  const submittedLimit = parsePanelLimit(overrides.submittedLimitRaw);
  const batchesLimit = parsePanelLimit(overrides.batchesLimitRaw);
  const messagesLimit = parsePanelLimit(overrides.messagesLimitRaw);

  const flags: OverrideFlags = {
    readerUrl: overrides.readerUrl !== undefined,
    posterUrl: overrides.posterUrl !== undefined,
    posterAuthToken: posterAuthToken.length > 0,
    contentTags: overrides.contentTagsRaw !== undefined,
    limits:
      overrides.pendingLimitRaw !== undefined ||
      overrides.submittedLimitRaw !== undefined ||
      overrides.batchesLimitRaw !== undefined ||
      overrides.messagesLimitRaw !== undefined,
  };

  return {
    config: {
      readerUrl,
      posterUrl,
      posterAuthToken,
      contentTags,
      pendingLimit,
      submittedLimit,
      batchesLimit,
      messagesLimit,
    },
    flags,
  };
}

export interface UseExplorerConfig {
  mounted: boolean;
  config: ExplorerConfig;
  flags: OverrideFlags;
  /** Raw stored override strings — used to seed Settings form fields. */
  rawOverrides: StoredOverrides;
  setOverride: (key: OverrideKey, value: string) => void;
  clearOverride: (key: OverrideKey) => void;
  resetAll: () => void;
}

export function useExplorerConfig(): UseExplorerConfig {
  const [mounted, setMounted] = useState(false);
  const [overrides, setOverrides] = useState<StoredOverrides>({});

  useEffect(() => {
    setOverrides(readStoredOverrides());
    setMounted(true);
  }, []);

  const setOverride = useCallback((key: OverrideKey, value: string) => {
    setOverrides((prev) => {
      const next = { ...prev, [key]: value };
      if (value.length === 0) delete next[key];
      writeStoredOverrides(next);
      return next;
    });
  }, []);

  const clearOverride = useCallback((key: OverrideKey) => {
    setOverrides((prev) => {
      const next = { ...prev };
      delete next[key];
      writeStoredOverrides(next);
      return next;
    });
  }, []);

  const resetAll = useCallback(() => {
    setOverrides({});
    writeStoredOverrides({});
  }, []);

  // Stable references — `config` is consumed as a `useEffect`
  // dependency by the Dashboard, so a new object every render would
  // trigger an infinite refetch loop.
  const merged = useMemo(() => mergeConfig(overrides), [overrides]);

  return {
    mounted,
    config: merged.config,
    flags: merged.flags,
    rawOverrides: overrides,
    setOverride,
    clearOverride,
    resetAll,
  };
}
