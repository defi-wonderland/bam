import { describe, it, expect } from 'vitest';
import type { Address } from 'bam-sdk';

import { DEFAULT_RATE_LIMIT, RateLimiter } from '../../src/ingest/rate-limit.js';

const ALICE = '0x1111111111111111111111111111111111111111' as Address;
const BOB = '0x2222222222222222222222222222222222222222' as Address;

class FakeClock {
  public now = 0;
  tick(ms: number): void {
    this.now += ms;
  }
  fn(): () => number {
    return () => this.now;
  }
}

describe('RateLimiter', () => {
  it('accepts requests within the limit', () => {
    const clock = new FakeClock();
    const rl = new RateLimiter({ windowMs: 1000, maxPerWindow: 3 }, clock.fn());
    expect(rl.check(ALICE).ok).toBe(true);
    expect(rl.check(ALICE).ok).toBe(true);
    expect(rl.check(ALICE).ok).toBe(true);
  });

  it('rejects the fourth request in the window with rate_limited', () => {
    const clock = new FakeClock();
    const rl = new RateLimiter({ windowMs: 1000, maxPerWindow: 3 }, clock.fn());
    rl.check(ALICE);
    rl.check(ALICE);
    rl.check(ALICE);
    const res = rl.check(ALICE);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('rate_limited');
  });

  it('slides: requests older than windowMs no longer count', () => {
    const clock = new FakeClock();
    const rl = new RateLimiter({ windowMs: 1000, maxPerWindow: 2 }, clock.fn());
    rl.check(ALICE); // t=0
    rl.check(ALICE); // t=0
    expect(rl.check(ALICE).ok).toBe(false);
    clock.tick(1001);
    expect(rl.check(ALICE).ok).toBe(true);
  });

  it('is keyed per signer — Alice hitting her limit does not affect Bob', () => {
    const clock = new FakeClock();
    const rl = new RateLimiter({ windowMs: 1000, maxPerWindow: 1 }, clock.fn());
    expect(rl.check(ALICE).ok).toBe(true);
    expect(rl.check(ALICE).ok).toBe(false);
    expect(rl.check(BOB).ok).toBe(true);
    expect(rl.check(BOB).ok).toBe(false);
  });

  it('normalizes address case', () => {
    const clock = new FakeClock();
    const rl = new RateLimiter({ windowMs: 1000, maxPerWindow: 1 }, clock.fn());
    expect(rl.check(('0x' + 'A'.repeat(40)) as Address).ok).toBe(true);
    expect(rl.check(('0x' + 'a'.repeat(40)) as Address).ok).toBe(false);
  });

  it('exposes a non-DoS default aligned with spec §Non-goals', () => {
    expect(DEFAULT_RATE_LIMIT.windowMs).toBeGreaterThan(0);
    expect(DEFAULT_RATE_LIMIT.maxPerWindow).toBeGreaterThan(0);
  });

  it('sweeps stale entries so tracked-count stays bounded (cubic review)', () => {
    const clock = new FakeClock();
    const rl = new RateLimiter({ windowMs: 1000, maxPerWindow: 1 }, clock.fn());
    // 1000 unique addresses submit once each.
    for (let i = 0; i < 1000; i++) {
      const addr = ('0x' + i.toString(16).padStart(40, '0')) as Address;
      rl.check(addr);
    }
    expect(rl._trackedCount()).toBe(1000);
    // Advance past the window so every entry's last timestamp is
    // stale, then trigger a check — the sweep runs at most once per
    // window and drops everything.
    clock.tick(1_500);
    const fresh = ('0xff'.padEnd(42, '0')) as Address;
    rl.check(fresh);
    // Only the fresh address remains.
    expect(rl._trackedCount()).toBe(1);
  });
});
