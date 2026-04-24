import type { BackoffConfig, HealthState } from '../types.js';

/**
 * Default bounded-exponential-backoff parameters.
 *
 * - Start at 500 ms, double each attempt, cap at 60 s.
 * - After 5 consecutive failures, health flips `ok` → `degraded`.
 * - After 50 consecutive failures, health flips → `unhealthy`.
 *
 * The submission loop uses one `BackoffState` per content tag so a
 * failing tag doesn't starve the others.
 */
export const DEFAULT_BACKOFF: BackoffConfig = {
  baseMs: 500,
  capMs: 60_000,
  degradedAfterAttempts: 5,
  unhealthyAfterAttempts: 50,
};

export class BackoffState {
  private consecutiveFailures = 0;

  constructor(private readonly config: BackoffConfig) {}

  /** Milliseconds to wait before the next attempt. */
  nextDelayMs(): number {
    const attempts = this.consecutiveFailures;
    if (attempts === 0) return 0;
    const raw = this.config.baseMs * 2 ** (attempts - 1);
    return Math.min(raw, this.config.capMs);
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
  }

  recordFailure(): void {
    this.consecutiveFailures += 1;
  }

  /** Total consecutive failures since the last success. */
  attempts(): number {
    return this.consecutiveFailures;
  }

  healthFromAttempts(): HealthState {
    if (this.consecutiveFailures >= this.config.unhealthyAfterAttempts) return 'unhealthy';
    if (this.consecutiveFailures >= this.config.degradedAfterAttempts) return 'degraded';
    return 'ok';
  }
}
