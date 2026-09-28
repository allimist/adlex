/** Fixed-window per-key limiter kept in memory (per process). Good enough to blunt floods from one IP. */
export class RateLimiter {
  constructor({ limit = 120, windowMs = 60000 } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = new Map();
    this.sweeper = setInterval(() => this.sweep(), windowMs);
    this.sweeper.unref?.();
  }

  /** Returns true when the request is allowed. */
  allow(key, now = Date.now()) {
    let e = this.hits.get(key);
    if (!e || e.reset <= now) {
      e = { count: 0, reset: now + this.windowMs };
      this.hits.set(key, e);
    }
    e.count++;
    return e.count <= this.limit;
  }

  sweep(now = Date.now()) {
    for (const [k, e] of this.hits) if (e.reset <= now) this.hits.delete(k);
  }
}
