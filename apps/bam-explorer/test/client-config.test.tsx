import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const STORAGE_KEY = 'bam-explorer.settings.v1';
const VALID_A = '0x' + 'aa'.repeat(32);
const VALID_B = '0x' + 'bb'.repeat(32);

beforeEach(() => {
  window.localStorage.clear();
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
  cleanup();
});

async function importHook() {
  // Re-import after env stubbing so `process.env.NEXT_PUBLIC_*` is
  // re-read inside `readEnvDefaults` for each scenario.
  vi.resetModules();
  return await import('../src/lib/client-config');
}

describe('useExplorerConfig — env defaults only', () => {
  it('seeds with empty defaults when no NEXT_PUBLIC_* envs are set', async () => {
    const { useExplorerConfig } = await importHook();
    const { result } = renderHook(() => useExplorerConfig());
    expect(result.current.mounted).toBe(true);
    expect(result.current.config.readerUrl).toBe('');
    expect(result.current.config.posterUrl).toBe('');
    expect(result.current.config.posterAuthToken).toBe('');
    expect(result.current.config.contentTags).toEqual([]);
    expect(result.current.flags).toEqual({
      readerUrl: false,
      posterUrl: false,
      posterAuthToken: false,
      contentTags: false,
      limits: false,
    });
  });

  it('uses NEXT_PUBLIC_DEFAULT_* when set and no overrides', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEFAULT_READER_URL', 'http://r.example');
    vi.stubEnv('NEXT_PUBLIC_DEFAULT_POSTER_URL', 'http://p.example');
    vi.stubEnv('NEXT_PUBLIC_DEFAULT_CONTENT_TAGS', VALID_A);
    const { useExplorerConfig } = await importHook();
    const { result } = renderHook(() => useExplorerConfig());
    expect(result.current.config.readerUrl).toBe('http://r.example');
    expect(result.current.config.posterUrl).toBe('http://p.example');
    expect(result.current.config.contentTags).toEqual([VALID_A]);
  });
});

describe('useExplorerConfig — overrides', () => {
  it('setOverride writes to localStorage and reflects in flags', async () => {
    const { useExplorerConfig } = await importHook();
    const { result } = renderHook(() => useExplorerConfig());
    act(() => {
      result.current.setOverride('readerUrl', 'http://override');
    });
    expect(result.current.config.readerUrl).toBe('http://override');
    expect(result.current.flags.readerUrl).toBe(true);
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}');
    expect(stored).toEqual({ readerUrl: 'http://override' });
  });

  it('setOverride to empty string clears the override', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEFAULT_READER_URL', 'http://default');
    const { useExplorerConfig } = await importHook();
    const { result } = renderHook(() => useExplorerConfig());
    act(() => result.current.setOverride('readerUrl', 'http://override'));
    expect(result.current.config.readerUrl).toBe('http://override');
    act(() => result.current.setOverride('readerUrl', ''));
    expect(result.current.config.readerUrl).toBe('http://default');
    expect(result.current.flags.readerUrl).toBe(false);
  });

  it('clearOverride removes the override', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEFAULT_POSTER_URL', 'http://default-poster');
    const { useExplorerConfig } = await importHook();
    const { result } = renderHook(() => useExplorerConfig());
    act(() => result.current.setOverride('posterUrl', 'http://override-poster'));
    act(() => result.current.clearOverride('posterUrl'));
    expect(result.current.config.posterUrl).toBe('http://default-poster');
    expect(result.current.flags.posterUrl).toBe(false);
  });

  it('content-tags override replaces the env list', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEFAULT_CONTENT_TAGS', VALID_A);
    const { useExplorerConfig } = await importHook();
    const { result } = renderHook(() => useExplorerConfig());
    act(() => result.current.setOverride('contentTagsRaw', VALID_B));
    expect(result.current.config.contentTags).toEqual([VALID_B]);
    expect(result.current.flags.contentTags).toBe(true);
  });

  it('resetAll clears every override', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEFAULT_READER_URL', 'http://default-r');
    const { useExplorerConfig } = await importHook();
    const { result } = renderHook(() => useExplorerConfig());
    act(() => result.current.setOverride('readerUrl', 'http://over-r'));
    act(() => result.current.setOverride('posterUrl', 'http://over-p'));
    act(() => result.current.setOverride('posterAuthToken', 'tok'));
    act(() => result.current.resetAll());
    expect(result.current.config.readerUrl).toBe('http://default-r');
    expect(result.current.config.posterUrl).toBe('');
    expect(result.current.config.posterAuthToken).toBe('');
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});

describe('useExplorerConfig — token handling', () => {
  it('does not read a token from any env', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEFAULT_POSTER_AUTH_TOKEN', 'leaky-token');
    const { useExplorerConfig } = await importHook();
    const { result } = renderHook(() => useExplorerConfig());
    expect(result.current.config.posterAuthToken).toBe('');
    expect(result.current.flags.posterAuthToken).toBe(false);
  });

  it('flags posterAuthToken when stored override is non-empty', async () => {
    const { useExplorerConfig } = await importHook();
    const { result } = renderHook(() => useExplorerConfig());
    act(() => result.current.setOverride('posterAuthToken', 'tok'));
    expect(result.current.flags.posterAuthToken).toBe(true);
  });
});

describe('useExplorerConfig — corrupt storage', () => {
  it('falls back to env defaults on malformed JSON in localStorage', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEFAULT_READER_URL', 'http://r.example');
    window.localStorage.setItem(STORAGE_KEY, '{not json');
    const { useExplorerConfig } = await importHook();
    const { result } = renderHook(() => useExplorerConfig());
    expect(result.current.config.readerUrl).toBe('http://r.example');
  });
});
