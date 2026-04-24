import { describe, expect, it } from 'vitest';

import { WorkerTimer } from '../../src/submission/scheduler.js';

describe('WorkerTimer', () => {
  it('calls tick repeatedly until tick() returns null', async () => {
    let calls = 0;
    const timer = new WorkerTimer(async () => {
      calls++;
      if (calls >= 3) return null;
      return 5;
    });
    timer.start(0);
    // Let the event loop drain a few ticks.
    await new Promise((r) => setTimeout(r, 60));
    await timer.stop();
    expect(calls).toBe(3);
  });

  it('stop() waits for the in-flight tick to drain', async () => {
    let finished = false;
    const timer = new WorkerTimer(async () => {
      await new Promise((r) => setTimeout(r, 30));
      finished = true;
      return null;
    });
    timer.start(0);
    await new Promise((r) => setTimeout(r, 5));
    await timer.stop();
    expect(finished).toBe(true);
  });

  it('start() is idempotent while running', async () => {
    let calls = 0;
    const timer = new WorkerTimer(async () => {
      calls++;
      return null;
    });
    timer.start(0);
    timer.start(0); // no-op
    await new Promise((r) => setTimeout(r, 20));
    await timer.stop();
    expect(calls).toBe(1);
  });

  it('a throwing tick reschedules rather than stopping the worker', async () => {
    let calls = 0;
    const timer = new WorkerTimer(async () => {
      calls++;
      if (calls === 1) throw new Error('boom');
      return null;
    });
    timer.start(0);
    // After the throw, the scheduler waits ~1s before retry. Give it
    // enough time to fire a second tick.
    await new Promise((r) => setTimeout(r, 1200));
    await timer.stop();
    expect(calls).toBeGreaterThanOrEqual(2);
  }, 10_000);

  it('stop() before any tick returns without waiting', async () => {
    const timer = new WorkerTimer(async () => null);
    // Never started → stop is a no-op.
    await timer.stop();
  });
});
