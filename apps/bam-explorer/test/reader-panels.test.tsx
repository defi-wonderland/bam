import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Bytes32 } from 'bam-sdk';

import { ReaderBatchesPanel } from '../src/components/ReaderBatchesPanel';
import { ReaderHealthPanel } from '../src/components/ReaderHealthPanel';
import { ReaderMessagesPanel } from '../src/components/ReaderMessagesPanel';
import type { PanelResult } from '../src/lib/panel-result';

const FETCHED_AT = 1_700_000_000_000;
const TAG_A = ('0x' + 'aa'.repeat(32)) as Bytes32;
const TAG_B = ('0x' + 'bb'.repeat(32)) as Bytes32;
const TX_HASH = '0x' + 'cc'.repeat(32);

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
  it('renders no_content_tags when noTagsConfigured=true', () => {
    render(<ReaderBatchesPanel resultsByTag={new Map()} noTagsConfigured />);
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
    render(<ReaderBatchesPanel resultsByTag={m} noTagsConfigured={false} />);
    expect(screen.getByTestId('reader-batches-ok')).toBeTruthy();
    const link = screen.getByTestId('reader-batches-row-link') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe(`/batches/${TX_HASH}`);
  });
});

describe('ReaderBatchesPanel — mixed-state tags', () => {
  it('renders one section per tag, each with its own status', () => {
    const m = new Map<Bytes32, PanelResult<unknown>>([
      [
        TAG_A,
        {
          kind: 'ok',
          data: { batches: [] },
          fetchedAt: FETCHED_AT,
        },
      ],
      [
        TAG_B,
        { kind: 'unreachable', detail: 'down', fetchedAt: FETCHED_AT },
      ],
    ]);
    render(<ReaderBatchesPanel resultsByTag={m} noTagsConfigured={false} />);
    const sections = screen.getAllByTestId('reader-batches-tag-section');
    expect(sections).toHaveLength(2);

    // Status badges across the panel: shell badge + per-tag badges.
    // We confirm at least one badge says "unreachable" (worst-case rolls up).
    const ariaLabels = Array.from(document.querySelectorAll('[role="status"]')).map((e) =>
      e.getAttribute('aria-label') ?? ''
    );
    expect(ariaLabels.some((l) => l.includes('unreachable'))).toBe(true);
    expect(ariaLabels.some((l) => l.includes('ok'))).toBe(true);
  });
});

describe('ReaderMessagesPanel — same shape as ReaderBatchesPanel', () => {
  it('renders empty-tags state', () => {
    render(<ReaderMessagesPanel resultsByTag={new Map()} noTagsConfigured />);
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
              { messageHash: '0x' + '11'.repeat(32), author: '0x' + '22'.repeat(20) },
            ],
          },
          fetchedAt: FETCHED_AT,
        },
      ],
    ]);
    render(<ReaderMessagesPanel resultsByTag={m} noTagsConfigured={false} />);
    expect(screen.getByTestId('reader-messages-ok')).toBeTruthy();
  });

  it('renders empty-tag-result distinct from no-tags-configured', () => {
    const m = new Map<Bytes32, PanelResult<unknown>>([
      [TAG_A, { kind: 'ok', data: { messages: [] }, fetchedAt: FETCHED_AT }],
    ]);
    render(<ReaderMessagesPanel resultsByTag={m} noTagsConfigured={false} />);
    expect(screen.getByTestId('reader-messages-empty')).toBeTruthy();
    expect(screen.queryByTestId('panel-not-configured')).toBeNull();
  });
});
