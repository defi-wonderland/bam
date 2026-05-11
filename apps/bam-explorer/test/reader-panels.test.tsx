import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Bytes32 } from 'bam-sdk';

import { ReaderBatchesPanel } from '../src/components/ReaderBatchesPanel';
import { ReaderHealthPanel } from '../src/components/ReaderHealthPanel';
import { ReaderMessagesPanel } from '../src/components/ReaderMessagesPanel';
import type { PanelResult } from '../src/lib/panel-result';
import { FETCHED_AT, TAG_A, TAG_B, TX_HASH } from './fixtures';

afterEach(cleanup);

describe('ReaderHealthPanel', () => {
  const variants: Array<PanelResult<unknown>> = [
    { kind: 'ok', data: { ok: true }, fetchedAt: FETCHED_AT },
    { kind: 'not_configured', reason: 'reader_url_not_configured', fetchedAt: FETCHED_AT },
    { kind: 'unreachable', detail: 'down', fetchedAt: FETCHED_AT },
    { kind: 'error', status: 500, fetchedAt: FETCHED_AT },
  ];

  it('renders four distinct text outputs across kinds', () => {
    const seen = new Set<string>();
    for (const result of variants) {
      const { container } = render(<ReaderHealthPanel result={result} />);
      seen.add(container.textContent ?? '');
      cleanup();
    }
    expect(seen.size).toBe(4);
  });

  it('renders the endpoint label', () => {
    const { container } = render(<ReaderHealthPanel result={variants[0]} />);
    expect(container.textContent).toContain('Reader GET /health');
  });
});

describe('ReaderBatchesPanel — empty tags state', () => {
  it('renders no_content_tags when resultsByTag is empty', () => {
    render(<ReaderBatchesPanel resultsByTag={new Map()} />);
    expect(screen.getByTestId('panel-not-configured')).toBeTruthy();
    expect(screen.queryByTestId('reader-batches-tag-section')).toBeNull();
  });
});

describe('ReaderBatchesPanel — single-tag ok state', () => {
  it('renders the tag section with the ok body and a clickable link to /batches/<txHash>', () => {
    const m = new Map<Bytes32, PanelResult<unknown>>([
      [
        TAG_A,
        {
          kind: 'ok',
          data: {
            batches: [
              { txHash: TX_HASH, blockNumber: 1234, status: 'confirmed', contentTag: TAG_A },
            ],
          },
          fetchedAt: FETCHED_AT,
        },
      ],
    ]);
    render(<ReaderBatchesPanel resultsByTag={m} />);
    expect(screen.getByTestId('reader-batches-ok')).toBeTruthy();
    const link = screen.getByTestId('reader-batches-row-link') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe(`/batches/${TX_HASH}`);
  });
});

describe('ReaderBatchesPanel — mixed-state tags', () => {
  it('renders one section per tag, each with its own status', () => {
    const m = new Map<Bytes32, PanelResult<unknown>>([
      [TAG_A, { kind: 'ok', data: { batches: [] }, fetchedAt: FETCHED_AT }],
      [TAG_B, { kind: 'unreachable', detail: 'down', fetchedAt: FETCHED_AT }],
    ]);
    render(<ReaderBatchesPanel resultsByTag={m} />);
    expect(screen.getAllByTestId('reader-batches-tag-section')).toHaveLength(2);

    // Worst-case rolls up to the shell badge: at least one
    // unreachable badge appears.
    const ariaLabels = Array.from(document.querySelectorAll('[role="status"]')).map(
      (e) => e.getAttribute('aria-label') ?? ''
    );
    expect(ariaLabels.some((l) => l.includes('unreachable'))).toBe(true);
    expect(ariaLabels.some((l) => l.includes('ok'))).toBe(true);
  });
});

describe('ReaderMessagesPanel', () => {
  it('renders empty-tags state for an empty map', () => {
    render(<ReaderMessagesPanel resultsByTag={new Map()} />);
    expect(screen.getByTestId('panel-not-configured')).toBeTruthy();
  });

  it('renders ok body for a populated tag', () => {
    const m = new Map<Bytes32, PanelResult<unknown>>([
      [
        TAG_A,
        {
          kind: 'ok',
          data: {
            messages: [
              { messageHash: '0x' + '11'.repeat(32), sender: '0x' + '22'.repeat(20) },
            ],
          },
          fetchedAt: FETCHED_AT,
        },
      ],
    ]);
    render(<ReaderMessagesPanel resultsByTag={m} />);
    expect(screen.getByTestId('reader-messages-ok')).toBeTruthy();
  });

  it('renders empty-tag-result distinct from no-tags-configured', () => {
    const m = new Map<Bytes32, PanelResult<unknown>>([
      [TAG_A, { kind: 'ok', data: { messages: [] }, fetchedAt: FETCHED_AT }],
    ]);
    render(<ReaderMessagesPanel resultsByTag={m} />);
    expect(screen.getByTestId('reader-messages-empty')).toBeTruthy();
    expect(screen.queryByTestId('panel-not-configured')).toBeNull();
  });

  it('renders every returned item (no hardcoded slice cap)', () => {
    const messages = Array.from({ length: 73 }, (_, i) => ({
      messageHash: '0x' + String(i).padStart(2, '0').repeat(32).slice(0, 64),
      sender: '0x' + 'aa'.repeat(20),
    }));
    const m = new Map<Bytes32, PanelResult<unknown>>([
      [TAG_A, { kind: 'ok', data: { messages }, fetchedAt: FETCHED_AT }],
    ]);
    render(<ReaderMessagesPanel resultsByTag={m} />);
    expect(
      document.querySelectorAll('[data-testid="reader-messages-ok"] tbody tr').length
    ).toBe(73);
  });
});
