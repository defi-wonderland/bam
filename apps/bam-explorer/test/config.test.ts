import { describe, expect, it } from 'vitest';

import { parseContentTags, parsePanelLimit } from '../src/lib/config';

const VALID_A = '0x' + 'aa'.repeat(32);
const VALID_B = '0x' + 'bb'.repeat(32);

describe('parseContentTags', () => {
  it('returns [] when undefined / null / empty / whitespace', () => {
    expect(parseContentTags(undefined)).toEqual([]);
    expect(parseContentTags(null)).toEqual([]);
    expect(parseContentTags('')).toEqual([]);
    expect(parseContentTags('   ')).toEqual([]);
  });

  it('parses a single valid tag', () => {
    expect(parseContentTags(VALID_A)).toEqual([VALID_A]);
  });

  it('parses multiple comma-separated tags', () => {
    expect(parseContentTags(`${VALID_A},${VALID_B}`)).toEqual([VALID_A, VALID_B]);
  });

  it('tolerates whitespace around commas', () => {
    expect(parseContentTags(` ${VALID_A} ,  ${VALID_B}  `)).toEqual([VALID_A, VALID_B]);
  });

  it('drops invalid tags but keeps valid ones', () => {
    expect(parseContentTags(`${VALID_A},not-hex,0xabc,${VALID_B}`)).toEqual([VALID_A, VALID_B]);
  });

  it('drops a too-short hex string', () => {
    expect(parseContentTags('0x' + 'aa'.repeat(31))).toEqual([]);
  });
});

describe('parsePanelLimit', () => {
  it('returns 50 by default when undefined / null / empty', () => {
    expect(parsePanelLimit(undefined)).toBe(50);
    expect(parsePanelLimit(null)).toBe(50);
    expect(parsePanelLimit('')).toBe(50);
    expect(parsePanelLimit('   ')).toBe(50);
  });

  it('accepts a valid numeric override within range', () => {
    expect(parsePanelLimit('1')).toBe(1);
    expect(parsePanelLimit('100')).toBe(100);
    expect(parsePanelLimit('200')).toBe(200);
  });

  it('falls back to 50 on out-of-range values', () => {
    expect(parsePanelLimit('0')).toBe(50);
    expect(parsePanelLimit('201')).toBe(50);
    expect(parsePanelLimit('99999')).toBe(50);
  });

  it('falls back to 50 on non-numeric values', () => {
    expect(parsePanelLimit('abc')).toBe(50);
    expect(parsePanelLimit('12.5')).toBe(50);
    expect(parsePanelLimit('-5')).toBe(50);
  });
});
