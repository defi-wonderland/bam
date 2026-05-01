import { describe, expect, it } from 'vitest';
import { FIELD_ELEMENTS_PER_BLOB } from 'bam-sdk';
import { validateSegmentRange } from './validate-range.js';

describe('validateSegmentRange', () => {
  it('accepts a normal interior range', () => {
    expect(validateSegmentRange(10, 100)).toEqual({ ok: true });
  });

  it('accepts the [0, 1) boundary', () => {
    expect(validateSegmentRange(0, 1)).toEqual({ ok: true });
  });

  it('accepts the [4095, 4096) boundary', () => {
    expect(validateSegmentRange(FIELD_ELEMENTS_PER_BLOB - 1, FIELD_ELEMENTS_PER_BLOB)).toEqual(
      { ok: true }
    );
  });

  it('accepts the full-blob range [0, 4096)', () => {
    expect(validateSegmentRange(0, FIELD_ELEMENTS_PER_BLOB)).toEqual({ ok: true });
  });

  it('rejects negative startFE', () => {
    expect(validateSegmentRange(-1, 10)).toEqual({ ok: false, reason: 'negative' });
  });

  it('rejects non-integer values', () => {
    expect(validateSegmentRange(0.5, 10)).toEqual({ ok: false, reason: 'not-integer' });
    expect(validateSegmentRange(0, 10.5)).toEqual({ ok: false, reason: 'not-integer' });
  });

  it('rejects NaN', () => {
    expect(validateSegmentRange(NaN, 10)).toEqual({ ok: false, reason: 'not-finite' });
    expect(validateSegmentRange(0, NaN)).toEqual({ ok: false, reason: 'not-finite' });
  });

  it('rejects endFE > FIELD_ELEMENTS_PER_BLOB', () => {
    expect(validateSegmentRange(0, FIELD_ELEMENTS_PER_BLOB + 1)).toEqual({
      ok: false,
      reason: 'endFE-exceeds-blob',
    });
  });

  it('rejects startFE >= endFE (inverted)', () => {
    expect(validateSegmentRange(10, 5)).toEqual({
      ok: false,
      reason: 'inverted-or-zero-length',
    });
  });

  it('rejects zero-length [n, n)', () => {
    expect(validateSegmentRange(5, 5)).toEqual({
      ok: false,
      reason: 'inverted-or-zero-length',
    });
  });

  it('rejects values larger than FIELD_ELEMENTS_PER_BLOB regardless of ABI width', () => {
    // The on-chain ABI is uint16, but the chokepoint accepts any
    // post-decode number — we still reject anything past 4096 since
    // it can never index a real blob slot.
    expect(validateSegmentRange(0, 2 ** 33)).toEqual({
      ok: false,
      reason: 'endFE-exceeds-blob',
    });
    expect(validateSegmentRange(0, 0xffff)).toEqual({
      ok: false,
      reason: 'endFE-exceeds-blob',
    });
  });
});
