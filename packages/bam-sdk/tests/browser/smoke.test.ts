import { describe, expect, it } from 'vitest';

import type { Address } from '../../src/types.js';
import { computeMessageHash } from '../../src/message.js';

describe('browser harness smoke', () => {
  it('jsdom environment is active (window is defined)', () => {
    // @ts-expect-error — window is provided by jsdom at runtime
    expect(typeof window).toBe('object');
  });

  it('computeMessageHash matches the Node vector under jsdom', () => {
    const sender = ('0x' + '11'.repeat(20)) as Address;
    const contents = new Uint8Array(35);
    contents.fill(0xaa, 0, 32);
    contents.set([0x41, 0x42, 0x43], 32);
    const hash = computeMessageHash(sender, 42n, contents);
    expect(hash).toBe('0xcd85d7e54cb158da66baa2ff0ea40828c61e4d078a320e2c266ad082f8da2656');
  });
});
