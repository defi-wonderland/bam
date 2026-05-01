import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readContentTags, readPanelLimit } from '../src/lib/config';

const VALID_A = '0x' + 'aa'.repeat(32);
const VALID_B = '0x' + 'bb'.repeat(32);

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('readContentTags', () => {
  it('returns [] when env is unset', () => {
    expect(readContentTags(undefined)).toEqual([]);
  });

  it('returns [] when env is empty', () => {
    expect(readContentTags('')).toEqual([]);
    expect(readContentTags('   ')).toEqual([]);
  });

  it('parses a single valid tag', () => {
    expect(readContentTags(VALID_A)).toEqual([VALID_A]);
  });

  it('parses multiple comma-separated tags', () => {
    expect(readContentTags(`${VALID_A},${VALID_B}`)).toEqual([VALID_A, VALID_B]);
  });

  it('tolerates whitespace around commas', () => {
    expect(readContentTags(` ${VALID_A} ,  ${VALID_B}  `)).toEqual([VALID_A, VALID_B]);
  });

  it('drops invalid tags but keeps valid ones', () => {
    const mixed = `${VALID_A},not-hex,0xabc,${VALID_B}`;
    expect(readContentTags(mixed)).toEqual([VALID_A, VALID_B]);
    expect(console.warn).toHaveBeenCalledTimes(2);
  });

  it('drops a wrong-case-but-malformed tag (too short)', () => {
    expect(readContentTags('0x' + 'aa'.repeat(31))).toEqual([]);
  });
});

describe('readPanelLimit', () => {
  it('returns 50 by default when env is unset', () => {
    expect(readPanelLimit('pending', undefined)).toBe(50);
    expect(readPanelLimit('submitted', undefined)).toBe(50);
    expect(readPanelLimit('batches', undefined)).toBe(50);
    expect(readPanelLimit('messages', undefined)).toBe(50);
  });

  it('returns 50 when env is empty / whitespace', () => {
    expect(readPanelLimit('pending', '')).toBe(50);
    expect(readPanelLimit('pending', '   ')).toBe(50);
  });

  it('accepts a valid numeric override within range', () => {
    expect(readPanelLimit('pending', '1')).toBe(1);
    expect(readPanelLimit('pending', '100')).toBe(100);
    expect(readPanelLimit('pending', '200')).toBe(200);
  });

  it('falls back to 50 on out-of-range values', () => {
    expect(readPanelLimit('pending', '0')).toBe(50);
    expect(readPanelLimit('pending', '201')).toBe(50);
    expect(readPanelLimit('pending', '99999')).toBe(50);
    expect(console.warn).toHaveBeenCalled();
  });

  it('falls back to 50 on non-numeric values', () => {
    expect(readPanelLimit('pending', 'abc')).toBe(50);
    expect(readPanelLimit('pending', '12.5')).toBe(50);
    expect(readPanelLimit('pending', '-5')).toBe(50);
    expect(console.warn).toHaveBeenCalled();
  });
});
