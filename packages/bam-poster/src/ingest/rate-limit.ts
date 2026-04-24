import type { Address } from 'bam-sdk';

import type { RateLimitConfig, ValidationResult } from '../types.js';

/**
 * Default rate-limit settings — a spam floor, not DoS mitigation.
 * Operators override via config.
 */
export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  windowMs: 60_000,
  maxPerWindow: 60,
};

/**
 * Sliding-window rate limiter keyed on the **signer address** (the
 * on-chain protocol identity the author claims in the envelope).
 * CROPS-P preserved: we never persist or log an IP.
 *
 * Runs after the size check and before crypto, so CPU-grief spam with
 * invalid signatures is rejected before `verifyECDSA` is ever called.
 *
 * The limiter is in-memory, process-local. If multi-instance
 * coordination is ever wanted, it lives behind this interface.
 */
export class RateLimiter {
  private readonly timestamps = new Map<Address, number[]>();
  /** Last time a cleanup sweep dropped empty / stale entries. */
  private lastSweepMs = 0;

  constructor(
    private readonly config: RateLimitConfig,
    private readonly now: () => number = () => Date.now()
  ) {}

  check(key: Address): ValidationResult {
    const now = this.now();
    const windowStart = now - this.config.windowMs;
    const normalized = key.toLowerCase() as Address;
    const history = this.timestamps.get(normalized) ?? [];

    // Drop stale entries; keep the window sliding.
    let writeIdx = 0;
    for (let i = 0; i < history.length; i++) {
      if (history[i] > windowStart) {
        history[writeIdx++] = history[i];
      }
    }
    history.length = writeIdx;

    // Cubic review: a Poster that sees many unique signer addresses
    // would grow the map unboundedly — entries whose history is now
    // empty (no submission within the window) are never removed.
    // Sweep at most once per window to drop them. Cost: O(|map|) on
    // the cleanup call; amortized O(1) per check.
    if (now - this.lastSweepMs >= this.config.windowMs) {
      for (const [addr, hist] of this.timestamps) {
        // Drop any entry whose *last* timestamp is already outside the
        // window — nothing useful remains.
        if (hist.length === 0 || hist[hist.length - 1] <= windowStart) {
          this.timestamps.delete(addr);
        }
      }
      this.lastSweepMs = now;
    }

    if (history.length >= this.config.maxPerWindow) {
      this.timestamps.set(normalized, history);
      return { ok: false, reason: 'rate_limited' };
    }

    history.push(now);
    this.timestamps.set(normalized, history);
    return { ok: true };
  }

  /** Test-only introspection: count of tracked signer addresses. */
  _trackedCount(): number {
    return this.timestamps.size;
  }
}
