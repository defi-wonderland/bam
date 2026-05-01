import { describe, expect, it } from 'vitest';
import type { Bytes32 } from 'bam-sdk';

import { readHealth } from '../../src/surfaces/health.js';

const TAG_A = ('0x' + 'a1'.repeat(32)) as Bytes32;
const TAG_B = ('0x' + 'b2'.repeat(32)) as Bytes32;
const TX = ('0x' + 'cc'.repeat(32)) as Bytes32;

describe('readHealth (aggregator block, T023)', () => {
  it('omits aggregator fields when no aggregator is wired', () => {
    const out = readHealth({ submissionState: 'ok' });
    expect(out).toEqual({ state: 'ok' });
  });

  it('emits per-tag entries with warn=false below the threshold', () => {
    const out = readHealth({
      submissionState: 'ok',
      aggregator: {
        lastPackedTxHash: TX,
        lastPackedTagCount: 2,
        permanentlyStopped: false,
        tags: [
          {
            contentTag: TAG_A,
            pendingCount: 0,
            packingLossStreak: 0,
            lastIncludedAt: 1_700_000_000_000,
            warn: false,
          },
          {
            contentTag: TAG_B,
            pendingCount: 5,
            packingLossStreak: 3,
            lastIncludedAt: null,
            warn: false,
          },
        ],
      },
    });
    expect(out.state).toBe('ok');
    expect(out.lastPackedTxHash).toBe(TX);
    expect(out.lastPackedTagCount).toBe(2);
    expect(out.permanentlyStopped).toBe(false);
    expect(out.tags).toHaveLength(2);
    expect(out.tags![0]!.warn).toBe(false);
  });

  it('threads `warn=true` through for tags whose streak crosses the threshold', () => {
    const out = readHealth({
      submissionState: 'ok',
      aggregator: {
        lastPackedTxHash: null,
        lastPackedTagCount: 0,
        permanentlyStopped: false,
        tags: [
          {
            contentTag: TAG_A,
            pendingCount: 12,
            packingLossStreak: 12,
            lastIncludedAt: null,
            warn: true,
          },
        ],
      },
    });
    expect(out.tags![0]!.warn).toBe(true);
  });

  it('emits aggregator block alongside non-ok submission state', () => {
    const out = readHealth({
      submissionState: 'unhealthy',
      reason: 'aggregator PERMANENT failure',
      since: new Date(0),
      aggregator: {
        lastPackedTxHash: null,
        lastPackedTagCount: 0,
        permanentlyStopped: true,
        tags: [],
      },
    });
    expect(out.state).toBe('unhealthy');
    expect(out.permanentlyStopped).toBe(true);
    expect(out.tags).toEqual([]);
  });
});
