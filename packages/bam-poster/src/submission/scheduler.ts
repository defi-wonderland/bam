/**
 * Minimal self-rescheduling timer. The callback returns the delay in
 * milliseconds until the next tick, or `null` to stop the worker
 * permanently (e.g. a submission loop that flipped to `unhealthy`).
 *
 * Exists so the Poster's `start()` spawns real autonomous work rather
 * than relying on an external driver poking `_tickTag`. Tests that
 * want deterministic stepping never call `start()` and use the
 * `InternalPoster` hooks directly.
 */
export class WorkerTimer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private currentTick: Promise<void> | null = null;

  constructor(private readonly tick: () => Promise<number | null>) {}

  start(initialDelayMs = 0): void {
    if (this.running) return;
    this.running = true;
    this.schedule(initialDelayMs);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.currentTick !== null) {
      // Wait for the in-flight tick to drain. Ignore failures — the
      // wrapper swallows them so the timer chain stays alive; here we
      // just need to confirm completion.
      try {
        await this.currentTick;
      } catch {
        // ignore
      }
    }
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.currentTick = this.runTick();
      void this.currentTick.finally(() => {
        this.currentTick = null;
      });
    }, delayMs);
  }

  private async runTick(): Promise<void> {
    if (!this.running) return;
    try {
      const next = await this.tick();
      if (next !== null) this.schedule(next);
    } catch {
      // A tick threw. Reschedule with a conservative 1 s delay so we
      // don't tight-loop on a broken callback, but don't stop the
      // worker (unlike a `null` return, which is explicit intent).
      if (this.running) this.schedule(1000);
    }
  }
}
