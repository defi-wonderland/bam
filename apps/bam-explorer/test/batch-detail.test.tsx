import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { BatchDetailCard, type BatchDetailState } from '../src/components/BatchDetailCard';

const TX_HASH = '0x' + 'cc'.repeat(32);
const FETCHED_AT = 1_700_000_000_000;

afterEach(cleanup);

describe('BatchDetailCard', () => {
  it('ok → renders the batch payload', () => {
    const state: BatchDetailState = {
      kind: 'ok',
      data: { batch: { txHash: TX_HASH, blockNumber: 123 } },
      fetchedAt: FETCHED_AT,
    };
    render(<BatchDetailCard txHash={TX_HASH} state={state} />);
    expect(screen.getByTestId('batch-detail-ok').textContent).toContain(TX_HASH);
  });

  it('not_found → renders the not-found state', () => {
    render(
      <BatchDetailCard
        txHash={TX_HASH}
        state={{ kind: 'not_found', fetchedAt: FETCHED_AT }}
      />
    );
    expect(screen.getByTestId('batch-detail-not-found')).toBeTruthy();
    expect(screen.queryByTestId('batch-detail-ok')).toBeNull();
  });

  it('malformed → renders the malformed state distinct from not_found', () => {
    render(
      <BatchDetailCard
        txHash="0x-not-hex"
        state={{ kind: 'malformed', fetchedAt: FETCHED_AT }}
      />
    );
    expect(screen.getByTestId('batch-detail-malformed')).toBeTruthy();
    expect(screen.queryByTestId('batch-detail-not-found')).toBeNull();
  });

  it('unreachable → renders the unreachable degraded state', () => {
    render(
      <BatchDetailCard
        txHash={TX_HASH}
        state={{ kind: 'unreachable', detail: 'down', fetchedAt: FETCHED_AT }}
      />
    );
    expect(screen.getByTestId('panel-unreachable')).toBeTruthy();
  });

  it('error → renders the error degraded state', () => {
    render(
      <BatchDetailCard
        txHash={TX_HASH}
        state={{ kind: 'error', status: 500, fetchedAt: FETCHED_AT }}
      />
    );
    expect(screen.getByTestId('panel-error')).toBeTruthy();
  });

  it('embeds the txHash in the endpoint label', () => {
    const { container } = render(
      <BatchDetailCard
        txHash={TX_HASH}
        state={{ kind: 'not_found', fetchedAt: FETCHED_AT }}
      />
    );
    expect(container.textContent).toContain(`Reader GET /batches/${TX_HASH}`);
  });
});
