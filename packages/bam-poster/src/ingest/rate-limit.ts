import type { Address } from 'bam-sdk';

import type { RateLimitConfig, ValidationResult } from '../types.js';

/**
 * Default rate-limit settings — a spam floor, not DoS mitigation
 * (spec §Goals / Non-goals). Operators override via config.
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
 * invalid signatures is rejected before `verifyECDSA` is ever called
 * (plan §C-1; ordering assertion lives in T011).
 *
 * The limiter is in-memory, process-local. If multi-instance
 * coordination is ever wanted, it lives behind this interface.
 */
export class RateLimiter {
  private readonly timestamps = new Map<Address, number[]>();

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

    if (history.length >= this.config.maxPerWindow) {
      this.timestamps.set(normalized, history);
      return { ok: false, reason: 'rate_limited' };
    }

    history.push(now);
    this.timestamps.set(normalized, history);
    return { ok: true };
  }

  /**
   * Release a slot reserved by a prior `check` that did not actually
   * proceed through ingest. Used when a later-running check rejects.
   */
  release(key: Address): void {
    const normalized = key.toLowerCase() as Address;
    const history = this.timestamps.get(normalized);
    if (!history || history.length === 0) return;
    history.pop();
  }
}
