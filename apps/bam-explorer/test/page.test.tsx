import { cleanup, render, screen } from '@testing-library/react';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { Bytes32 } from 'bam-sdk';

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
import Page from '../src/app/page';

const TAG_A = ('0x' + 'aa'.repeat(32)) as Bytes32;
const FETCHED_AT = 1_700_000_000_000;

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

async function renderPage(): Promise<void> {
  const el = await Page();
  render(el);
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.EXPLORER_CONTENT_TAGS = TAG_A;
});

afterEach(() => {
  cleanup();
  delete process.env.EXPLORER_CONTENT_TAGS;
});

describe('dashboard page — happy path', () => {
  it('renders all eight panels with their endpoint labels when everything is ok', async () => {
    setAllOk();
    await renderPage();

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

describe('dashboard page — partial offline (gate G-6)', () => {
  it('Reader unreachable: Poster panels still render ok, Reader panels render unreachable', async () => {
    vi.mocked(fetchers.fetchPosterHealth).mockResolvedValue(ok({ health: { state: 'ok' } }));
    vi.mocked(fetchers.fetchPosterStatus).mockResolvedValue(ok({ status: {} }));
    vi.mocked(fetchers.fetchPosterPending).mockResolvedValue(ok({ pending: [] }));
    vi.mocked(fetchers.fetchPosterSubmittedBatches).mockResolvedValue(ok({ batches: [] }));
    vi.mocked(fetchers.fetchReaderHealth).mockResolvedValue(unreachable());
    vi.mocked(fetchers.fetchReaderBatches).mockResolvedValue(unreachable());
    vi.mocked(fetchers.fetchReaderMessages).mockResolvedValue(unreachable());

    await renderPage();

    expect(screen.getByTestId('poster-health-ok')).toBeTruthy();
    expect(screen.getByTestId('poster-status-ok')).toBeTruthy();
    expect(screen.getByTestId('poster-pending-empty')).toBeTruthy();
    expect(screen.getByTestId('poster-submitted-empty')).toBeTruthy();
    // Reader-side panels should show degraded state, not ok
    expect(screen.queryByTestId('reader-health-ok')).toBeNull();
    expect(screen.queryByTestId('reader-batches-ok')).toBeNull();
    expect(screen.queryByTestId('reader-messages-ok')).toBeNull();
    // At least one unreachable badge
    const unreachableNodes = document.querySelectorAll('[data-testid="panel-unreachable"]');
    expect(unreachableNodes.length).toBeGreaterThan(0);
  });

  it('Poster unreachable: Reader panels still render ok, Poster panels render unreachable', async () => {
    vi.mocked(fetchers.fetchPosterHealth).mockResolvedValue(unreachable());
    vi.mocked(fetchers.fetchPosterStatus).mockResolvedValue(unreachable());
    vi.mocked(fetchers.fetchPosterPending).mockResolvedValue(unreachable());
    vi.mocked(fetchers.fetchPosterSubmittedBatches).mockResolvedValue(unreachable());
    vi.mocked(fetchers.fetchReaderHealth).mockResolvedValue(ok({ ok: true }));
    vi.mocked(fetchers.fetchReaderBatches).mockResolvedValue(ok({ batches: [] }));
    vi.mocked(fetchers.fetchReaderMessages).mockResolvedValue(ok({ messages: [] }));

    await renderPage();

    expect(screen.getByTestId('reader-health-ok')).toBeTruthy();
    expect(screen.queryByTestId('poster-health-ok')).toBeNull();
    expect(screen.queryByTestId('poster-status-ok')).toBeNull();
    expect(screen.queryByTestId('poster-pending-empty')).toBeNull();
  });
});

describe('dashboard page — no content tags configured', () => {
  it('renders Reader-list panels in no_content_tags state but Reader /health still ok', async () => {
    delete process.env.EXPLORER_CONTENT_TAGS;
    setAllOk();
    await renderPage();

    const notConfigured = document.querySelectorAll('[data-testid="panel-not-configured"]');
    // Two panels (Reader batches + Reader messages) in not_configured.
    expect(notConfigured.length).toBeGreaterThanOrEqual(2);

    // Reader /health renders independently.
    expect(screen.getByTestId('reader-health-ok')).toBeTruthy();
    // Poster panels also render normally.
    expect(screen.getByTestId('poster-health-ok')).toBeTruthy();
  });
});

describe('dashboard page — freshness indicator (gate G-7)', () => {
  it('renders the global freshness component', async () => {
    setAllOk();
    await renderPage();
    expect(screen.getAllByTestId('freshness').length).toBeGreaterThan(0);
  });
});
