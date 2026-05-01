import { describe, expect, it } from 'vitest';
import {
  FIELD_ELEMENTS_PER_BLOB,
  USABLE_BYTES_PER_BLOB,
  USABLE_BYTES_PER_FIELD_ELEMENT,
} from 'bam-sdk';
import type { Bytes32 } from 'bam-sdk';

import {
  defaultPackCapacity,
  planPack,
  validatePackPlanInvariants,
  type PerTagSelection,
} from '../../src/submission/pack.js';

const TAG_A = ('0x' + 'a1'.repeat(32)) as Bytes32;
const TAG_B = ('0x' + 'b2'.repeat(32)) as Bytes32;
const TAG_C = ('0x' + 'c3'.repeat(32)) as Bytes32;

function selection(
  tag: Bytes32,
  payloadBytes: number,
  oldestIngestedAt: number,
  pendingMessageCount = 1
): PerTagSelection {
  return {
    contentTag: tag,
    payloadBytes: new Uint8Array(payloadBytes),
    oldestIngestedAt,
    pendingMessageCount,
  };
}

describe('planPack', () => {
  it('empty pools produce an empty plan', () => {
    const plan = planPack([], defaultPackCapacity());
    expect(plan.included).toEqual([]);
    expect(plan.excluded).toEqual([]);
  });

  it('single tag produces a tight range starting at 0', () => {
    const payloadBytes = USABLE_BYTES_PER_FIELD_ELEMENT * 7 - 3; // 7 FEs (rounded up)
    const plan = planPack([selection(TAG_A, payloadBytes, 1_000)], defaultPackCapacity());
    expect(plan.included).toHaveLength(1);
    expect(plan.included[0]!).toMatchObject({
      contentTag: TAG_A,
      startFE: 0,
      endFE: 7,
    });
    expect(plan.excluded).toEqual([]);
  });

  it('two tags tiling exactly to FIELD_ELEMENTS_PER_BLOB', () => {
    const halfBytes = (FIELD_ELEMENTS_PER_BLOB / 2) * USABLE_BYTES_PER_FIELD_ELEMENT;
    const plan = planPack(
      [selection(TAG_A, halfBytes, 100), selection(TAG_B, halfBytes, 200)],
      defaultPackCapacity()
    );
    expect(plan.included).toHaveLength(2);
    expect(plan.included[0]!.endFE).toBe(FIELD_ELEMENTS_PER_BLOB / 2);
    expect(plan.included[1]!.endFE).toBe(FIELD_ELEMENTS_PER_BLOB);
    expect(plan.excluded).toEqual([]);
  });

  it('three tags overflowing — newest excluded by oldest-first arbitration', () => {
    const halfBytes = (FIELD_ELEMENTS_PER_BLOB / 2) * USABLE_BYTES_PER_FIELD_ELEMENT;
    const plan = planPack(
      [
        selection(TAG_A, halfBytes, 100),
        selection(TAG_B, halfBytes, 200),
        // TAG_C is newest; doesn't fit and gets excluded.
        selection(TAG_C, halfBytes, 300, 5),
      ],
      defaultPackCapacity()
    );
    expect(plan.included.map((s) => s.contentTag)).toEqual([TAG_A, TAG_B]);
    expect(plan.excluded).toHaveLength(1);
    expect(plan.excluded[0]!).toEqual({ contentTag: TAG_C, pendingMessageCount: 5 });
  });

  it('identical oldestIngestedAt → stable tiebreak by contentTag lexicographic order', () => {
    const tinyBytes = USABLE_BYTES_PER_FIELD_ELEMENT;
    const plan = planPack(
      [
        selection(TAG_B, tinyBytes, 1_000),
        selection(TAG_A, tinyBytes, 1_000),
        selection(TAG_C, tinyBytes, 1_000),
      ],
      defaultPackCapacity()
    );
    // TAG_A (0xa1…), TAG_B (0xb2…), TAG_C (0xc3…) — sorted lexicographically.
    expect(plan.included.map((s) => s.contentTag)).toEqual([TAG_A, TAG_B, TAG_C]);
  });

  it('skips zero-byte payloads (zero-length range would fail on-chain validation)', () => {
    const plan = planPack(
      [selection(TAG_A, 0, 100), selection(TAG_B, 32, 200)],
      defaultPackCapacity()
    );
    expect(plan.included.map((s) => s.contentTag)).toEqual([TAG_B]);
    expect(plan.excluded.map((s) => s.contentTag)).toEqual([TAG_A]);
  });
});

describe('validatePackPlanInvariants', () => {
  it('accepts a well-formed plan', () => {
    expect(() =>
      validatePackPlanInvariants({
        included: [
          { contentTag: TAG_A, startFE: 0, endFE: 10, payloadBytes: new Uint8Array(310) },
          { contentTag: TAG_B, startFE: 10, endFE: 20, payloadBytes: new Uint8Array(310) },
        ],
        excluded: [],
      })
    ).not.toThrow();
  });

  it('throws on overlap', () => {
    expect(() =>
      validatePackPlanInvariants({
        included: [
          { contentTag: TAG_A, startFE: 0, endFE: 10, payloadBytes: new Uint8Array(310) },
          { contentTag: TAG_B, startFE: 5, endFE: 15, payloadBytes: new Uint8Array(310) },
        ],
        excluded: [],
      })
    ).toThrow(/overlap/);
  });

  it('throws on out-of-bounds endFE', () => {
    expect(() =>
      validatePackPlanInvariants({
        included: [
          {
            contentTag: TAG_A,
            startFE: 0,
            endFE: FIELD_ELEMENTS_PER_BLOB + 1,
            payloadBytes: new Uint8Array(310),
          },
        ],
        excluded: [],
      })
    ).toThrow(/malformed segment/);
  });

  it('throws on inverted range', () => {
    expect(() =>
      validatePackPlanInvariants({
        included: [
          { contentTag: TAG_A, startFE: 100, endFE: 50, payloadBytes: new Uint8Array(310) },
        ],
        excluded: [],
      })
    ).toThrow(/malformed segment/);
  });

  it('throws on non-monotonic order even when ranges do not technically overlap', () => {
    // Hand-crafted: TAG_B's startFE >= TAG_A's endFE but it appears
    // BEFORE TAG_A in the included list. The validator surfaces it as
    // a non-monotonic-order error so the broadcast is refused.
    expect(() =>
      validatePackPlanInvariants({
        included: [
          { contentTag: TAG_B, startFE: 10, endFE: 20, payloadBytes: new Uint8Array(310) },
          { contentTag: TAG_A, startFE: 0, endFE: 10, payloadBytes: new Uint8Array(310) },
        ],
        excluded: [],
      })
    ).toThrow(/overlap or non-monotonic/);
  });
});

describe('planPack against a narrow capacity', () => {
  it('respects a custom maxFEs cap below FIELD_ELEMENTS_PER_BLOB', () => {
    // 100-FE cap; tag A takes 80 FEs of payload (~2480 bytes), tag B
    // would need 30 more FEs but only 20 remain.
    const aBytes = USABLE_BYTES_PER_FIELD_ELEMENT * 80;
    const bBytes = USABLE_BYTES_PER_FIELD_ELEMENT * 30;
    const plan = planPack(
      [selection(TAG_A, aBytes, 100), selection(TAG_B, bBytes, 200)],
      { maxFEs: 100, maxBytes: USABLE_BYTES_PER_BLOB }
    );
    expect(plan.included.map((s) => s.contentTag)).toEqual([TAG_A]);
    expect(plan.excluded.map((s) => s.contentTag)).toEqual([TAG_B]);
  });
});
