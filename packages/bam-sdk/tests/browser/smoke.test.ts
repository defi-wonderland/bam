import { describe, expect, it } from 'vitest';

import type { Address, Bytes32 } from '../../src/types.js';
import { computeMessageHash } from '../../src/message.js';

describe('browser harness smoke', () => {
  it('jsdom environment is active (window is defined)', () => {
    // @ts-expect-error — window is provided by jsdom at runtime
    expect(typeof window).toBe('object');
  });

  it('computeMessageHash runs and produces a 32-byte hash under jsdom', () => {
    const sender = ('0x' + '11'.repeat(20)) as Address;
    const contentTag = ('0x' + 'aa'.repeat(32)) as Bytes32;
    const contents = new Uint8Array([0x41, 0x42, 0x43]);
    const hash = computeMessageHash(sender, contentTag, 42n, contents);
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
