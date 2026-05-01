import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import type { PanelResult } from '../src/lib/panel-result';

vi.mock('../src/lib/fetchers', () => ({
  fetchPosterHealth: vi.fn(),
  fetchPosterStatus: vi.fn(),
  fetchPosterPending: vi.fn(),
  fetchPosterSubmittedBatches: vi.fn(),
  fetchReaderHealth: vi.fn(),
  fetchReaderBatches: vi.fn(),
  fetchReaderMessages: vi.fn(),
  fetchReaderBatchByTxHash: vi.fn(),
}));

import * as fetchers from '../src/lib/fetchers';
import { Dashboard } from '../src/components/Dashboard';

const TAG = '0x' + 'aa'.repeat(32);
const FETCHED_AT = 1_700_000_000_000;
const STORAGE_KEY = 'bam-explorer.settings.v1';

function ok<T>(data: T): PanelResult<T> {
  return { kind: 'ok', data, fetchedAt: FETCHED_AT };
}

function unreachable<T>(detail = 'down'): PanelResult<T> {
  return { kind: 'unreachable', detail, fetchedAt: FETCHED_AT };
}

function setAllOk(): void {
  vi.mocked(fetchers.fetchPosterHealth).mockResolvedValue(ok({ health: { state: 'ok' } }));
  vi.mocked(fetchers.fetchPosterStatus).mockResolvedValue(ok({ status: { foo: 'bar' } }));
  vi.mocked(fetchers.fetchPosterPending).mockResolvedValue(ok({ pending: [] }));
  vi.mocked(fetchers.fetchPosterSubmittedBatches).mockResolvedValue(ok({ batches: [] }));
  vi.mocked(fetchers.fetchReaderHealth).mockResolvedValue(ok({ ok: true }));
  vi.mocked(fetchers.fetchReaderBatches).mockResolvedValue(ok({ batches: [] }));
  vi.mocked(fetchers.fetchReaderMessages).mockResolvedValue(ok({ messages: [] }));
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  vi.unstubAllEnvs();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.unstubAllEnvs();
});

describe('Dashboard — happy path', () => {
  it('renders all panels with their endpoint labels when env defaults are set and everything is ok', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEFAULT_READER_URL', 'http://r');
    vi.stubEnv('NEXT_PUBLIC_DEFAULT_POSTER_URL', 'http://p');
    vi.stubEnv('NEXT_PUBLIC_DEFAULT_CONTENT_TAGS', TAG);
    setAllOk();

    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.queryByTestId('dashboard-loading')).toBeNull();
    });

    const text = document.body.textContent ?? '';
    expect(text).toContain('Poster GET /health');
    expect(text).toContain('Poster GET /status');
    expect(text).toContain('Poster GET /pending');
    expect(text).toContain('Poster GET /submitted-batches');
    expect(text).toContain('Reader GET /health');
    expect(text).toContain('Reader GET /batches');
    expect(text).toContain('Reader GET /messages');
  });
});

describe('Dashboard — partial offline (gate G-6)', () => {
  it('Reader unreachable: Poster panels render ok, Reader panels render unreachable', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEFAULT_READER_URL', 'http://r');
    vi.stubEnv('NEXT_PUBLIC_DEFAULT_POSTER_URL', 'http://p');
    vi.stubEnv('NEXT_PUBLIC_DEFAULT_CONTENT_TAGS', TAG);
    vi.mocked(fetchers.fetchPosterHealth).mockResolvedValue(ok({ health: { state: 'ok' } }));
    vi.mocked(fetchers.fetchPosterStatus).mockResolvedValue(ok({ status: {} }));
    vi.mocked(fetchers.fetchPosterPending).mockResolvedValue(ok({ pending: [] }));
    vi.mocked(fetchers.fetchPosterSubmittedBatches).mockResolvedValue(ok({ batches: [] }));
    vi.mocked(fetchers.fetchReaderHealth).mockResolvedValue(unreachable());
    vi.mocked(fetchers.fetchReaderBatches).mockResolvedValue(unreachable());
    vi.mocked(fetchers.fetchReaderMessages).mockResolvedValue(unreachable());

    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.queryByTestId('poster-health-ok')).not.toBeNull();
    });
    expect(screen.getByTestId('poster-status-ok')).toBeTruthy();
    expect(screen.getByTestId('poster-pending-empty')).toBeTruthy();
    expect(screen.getByTestId('poster-submitted-empty')).toBeTruthy();
    expect(screen.queryByTestId('reader-health-ok')).toBeNull();
    expect(screen.queryByTestId('reader-batches-ok')).toBeNull();
    expect(screen.queryByTestId('reader-messages-ok')).toBeNull();
    expect(document.querySelectorAll('[data-testid="panel-unreachable"]').length).toBeGreaterThan(0);
  });

  it('Poster unreachable: Reader panels render ok, Poster panels render unreachable', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEFAULT_READER_URL', 'http://r');
    vi.stubEnv('NEXT_PUBLIC_DEFAULT_POSTER_URL', 'http://p');
    vi.stubEnv('NEXT_PUBLIC_DEFAULT_CONTENT_TAGS', TAG);
    vi.mocked(fetchers.fetchPosterHealth).mockResolvedValue(unreachable());
    vi.mocked(fetchers.fetchPosterStatus).mockResolvedValue(unreachable());
    vi.mocked(fetchers.fetchPosterPending).mockResolvedValue(unreachable());
    vi.mocked(fetchers.fetchPosterSubmittedBatches).mockResolvedValue(unreachable());
    vi.mocked(fetchers.fetchReaderHealth).mockResolvedValue(ok({ ok: true }));
    vi.mocked(fetchers.fetchReaderBatches).mockResolvedValue(ok({ batches: [] }));
    vi.mocked(fetchers.fetchReaderMessages).mockResolvedValue(ok({ messages: [] }));

    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.queryByTestId('reader-health-ok')).not.toBeNull();
    });
    expect(screen.queryByTestId('poster-health-ok')).toBeNull();
  });
});

describe('Dashboard — no content tags configured', () => {
  it('renders Reader-list panels in no_content_tags state', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEFAULT_READER_URL', 'http://r');
    vi.stubEnv('NEXT_PUBLIC_DEFAULT_POSTER_URL', 'http://p');
    setAllOk();

    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.queryByTestId('reader-health-ok')).not.toBeNull();
    });
    expect(document.querySelectorAll('[data-testid="panel-not-configured"]').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByTestId('poster-health-ok')).toBeTruthy();
  });
});

describe('Dashboard — override active indicator', () => {
  it('shows the override badge on Reader panels when readerUrl is overridden', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEFAULT_READER_URL', 'http://r');
    vi.stubEnv('NEXT_PUBLIC_DEFAULT_POSTER_URL', 'http://p');
    vi.stubEnv('NEXT_PUBLIC_DEFAULT_CONTENT_TAGS', TAG);
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ readerUrl: 'http://overridden-reader' })
    );
    setAllOk();

    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.queryByTestId('reader-health-ok')).not.toBeNull();
    });
    const overrideFlags = document.querySelectorAll('[data-testid="panel-override-flag"]');
    // Reader panels: health, batches, messages → 3 of them.
    expect(overrideFlags.length).toBe(3);
  });

  it('shows no override badges when nothing is overridden', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEFAULT_READER_URL', 'http://r');
    vi.stubEnv('NEXT_PUBLIC_DEFAULT_POSTER_URL', 'http://p');
    vi.stubEnv('NEXT_PUBLIC_DEFAULT_CONTENT_TAGS', TAG);
    setAllOk();

    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.queryByTestId('reader-health-ok')).not.toBeNull();
    });
    expect(document.querySelectorAll('[data-testid="panel-override-flag"]').length).toBe(0);
  });
});

describe('Dashboard — freshness + refresh (gate G-7)', () => {
  it('renders the global freshness indicator', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEFAULT_READER_URL', 'http://r');
    vi.stubEnv('NEXT_PUBLIC_DEFAULT_POSTER_URL', 'http://p');
    setAllOk();

    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.queryByTestId('freshness')).not.toBeNull();
    });
  });

  it('Refresh button triggers another fetch round', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEFAULT_READER_URL', 'http://r');
    vi.stubEnv('NEXT_PUBLIC_DEFAULT_POSTER_URL', 'http://p');
    setAllOk();

    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.queryByTestId('refresh-button')).not.toBeNull();
    });
    const callsAfterMount = vi.mocked(fetchers.fetchPosterHealth).mock.calls.length;
    expect(callsAfterMount).toBeGreaterThan(0);

    await act(async () => {
      (screen.getByTestId('refresh-button') as HTMLButtonElement).click();
    });
    await waitFor(() => {
      expect(vi.mocked(fetchers.fetchPosterHealth).mock.calls.length).toBeGreaterThan(callsAfterMount);
    });
  });
});
