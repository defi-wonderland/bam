import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { PosterHealthPanel } from '../src/components/PosterHealthPanel';
import { PosterPendingPanel } from '../src/components/PosterPendingPanel';
import { PosterStatusPanel } from '../src/components/PosterStatusPanel';
import { PosterSubmittedBatchesPanel } from '../src/components/PosterSubmittedBatchesPanel';
import type { PanelResult } from '../src/lib/panel-result';

const FETCHED_AT = 1_700_000_000_000;

const variants = (okData: unknown): Array<{ label: string; result: PanelResult<unknown> }> => [
  { label: 'ok', result: { kind: 'ok', data: okData, fetchedAt: FETCHED_AT } },
  {
    label: 'not_configured',
    result: {
      kind: 'not_configured',
      reason: 'poster_url_not_configured',
      fetchedAt: FETCHED_AT,
    },
  },
  {
    label: 'unreachable',
    result: { kind: 'unreachable', detail: 'connection refused', fetchedAt: FETCHED_AT },
  },
  { label: 'error', result: { kind: 'error', status: 503, fetchedAt: FETCHED_AT } },
];

afterEach(cleanup);

describe('Poster panels — render distinct accessible state per kind', () => {
  const panels = [
    {
      name: 'PosterHealthPanel',
      Component: PosterHealthPanel,
      okData: { health: { state: 'ok' } },
      okTestId: 'poster-health-ok',
    },
    {
      name: 'PosterStatusPanel',
      Component: PosterStatusPanel,
      okData: { status: { foo: 'bar' } },
      okTestId: 'poster-status-ok',
    },
    {
      name: 'PosterPendingPanel',
      Component: PosterPendingPanel,
      okData: { pending: [] },
      okTestId: 'poster-pending-empty',
    },
    {
      name: 'PosterSubmittedBatchesPanel',
      Component: PosterSubmittedBatchesPanel,
      okData: { batches: [] },
      okTestId: 'poster-submitted-empty',
    },
  ];

  for (const { name, Component, okData, okTestId } of panels) {
    describe(name, () => {
      const seenTexts = new Set<string>();
      for (const { label, result } of variants(okData)) {
        it(`renders kind=${label} with a status badge`, () => {
          const { container } = render(<Component result={result} />);
          const badge = container.querySelector('[role="status"]');
          expect(badge?.getAttribute('aria-label')).toContain(label.replace('_', ' '));
          seenTexts.add(container.textContent ?? '');
        });
      }
      it('all four kinds produce distinct rendered text', () => {
        // re-render all four and collect
        const collected = new Set<string>();
        for (const { result } of variants(okData)) {
          const { container } = render(<Component result={result} />);
          collected.add(container.textContent ?? '');
          cleanup();
        }
        expect(collected.size).toBe(4);
      });
      it('renders the ok-specific testid only on kind=ok', () => {
        for (const { label, result } of variants(okData)) {
          render(<Component result={result} />);
          if (label === 'ok') {
            expect(screen.queryByTestId(okTestId)).not.toBeNull();
          } else {
            expect(screen.queryByTestId(okTestId)).toBeNull();
          }
          cleanup();
        }
      });
      it('renders the endpoint label exactly as specified', () => {
        const { container } = render(<Component result={variants(okData)[0].result} />);
        const endpointText = container.textContent ?? '';
        expect(endpointText).toContain(getEndpoint(name));
      });
    });
  }
});

function getEndpoint(name: string): string {
  if (name === 'PosterHealthPanel') return 'Poster GET /health';
  if (name === 'PosterStatusPanel') return 'Poster GET /status';
  if (name === 'PosterPendingPanel') return 'Poster GET /pending';
  if (name === 'PosterSubmittedBatchesPanel') return 'Poster GET /submitted-batches';
  throw new Error('unreachable');
}
