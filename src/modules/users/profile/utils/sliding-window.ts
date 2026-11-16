const SWEEP_THRESHOLD = 10_000;

/** In-memory sliding window per key (per process, reset on restart). */
export class SlidingWindow {
  private readonly hits = new Map<string, number[]>();

  private recent(key: string, now: number, windowMs: number): number[] {
    return (this.hits.get(key) ?? []).filter((at) => at > now - windowMs);
  }

  /** Seconds until another hit is allowed; 0 when the window has room. */
  retryAfter(key: string, limit: number, windowMs: number): number {
    const now = Date.now();
    const recent = this.recent(key, now, windowMs);
    return recent.length < limit
      ? 0
      : Math.max(1, Math.ceil((recent[0] + windowMs - now) / 1000));
  }

  record(key: string, windowMs: number): void {
    const now = Date.now();
    this.hits.set(key, [...this.recent(key, now, windowMs), now]);
    if (this.hits.size > SWEEP_THRESHOLD) {
      for (const [k, stamps] of this.hits) {
        if (stamps.every((at) => at <= now - windowMs)) this.hits.delete(k);
      }
    }
  }
}
