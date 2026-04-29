import { describe, expect, it } from 'vitest';

import type { ReaderEvent } from '../../src/types.js';

describe('ReaderEvent.backfill_progress', () => {
  it('contains only structural number fields (gate G-8)', () => {
    const event: ReaderEvent = {
      kind: 'backfill_progress',
      fromBlock: 1_000,
      toBlock: 2_000,
      currentBlock: 1_500,
      scanned: 12,
      processed: 10,
    };
    const json = JSON.parse(JSON.stringify(event));
    expect(Object.keys(json).sort()).toEqual(
      ['currentBlock', 'fromBlock', 'kind', 'processed', 'scanned', 'toBlock'].sort()
    );
    for (const key of ['fromBlock', 'toBlock', 'currentBlock', 'scanned', 'processed']) {
      expect(typeof (event as Record<string, unknown>)[key]).toBe('number');
    }
  });

  it('rejects a string field on backfill_progress at the type level', () => {
    // Type-level guard: adding a free-form string field to the variant
    // (the qodo PR #29 DSN-leak risk class) must fail TS. Mirrors the
    // gate G-8 invariant in `plan.md`.
    // @ts-expect-error -- backfill_progress payload must not carry strings
    const bad: ReaderEvent = {
      kind: 'backfill_progress',
      fromBlock: 1,
      toBlock: 2,
      currentBlock: 1,
      scanned: 0,
      processed: 0,
      detail: 'postgres://user:pass@host/db',
    };
    expect(bad.kind).toBe('backfill_progress');
  });
});
