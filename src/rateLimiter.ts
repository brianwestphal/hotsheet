// HS-8986 — a small, pure, in-memory sliding-window rate limiter used to bound
// flood / DoS attempts on an exposed server (the request-guards middleware
// applies it per remote IP; loopback callers are exempt so local dev / Claude /
// the local browser poll are never throttled). No I/O — the clock is injected.

export interface RateLimiter {
  /** Record a hit for `key` at `now` (ms). Returns false when the key has
   *  exceeded `max` hits in the trailing `windowMs` (the caller rejects with
   *  429); true when the hit is allowed. */
  tryConsume(key: string, now: number): boolean;
  /** Drop timestamps older than the window for every key (housekeeping so the
   *  map doesn't grow unbounded under churn). Safe to call periodically. */
  prune(now: number): void;
  /** Live key count (test/diagnostic aid). */
  size(): number;
}

export interface RateLimiterOptions {
  /** Trailing window in ms. */
  windowMs: number;
  /** Max hits allowed per key within the window. */
  max: number;
}

export function createRateLimiter({ windowMs, max }: RateLimiterOptions): RateLimiter {
  if (windowMs <= 0 || max <= 0) throw new Error('rateLimiter: windowMs and max must be > 0');
  // key → ascending hit timestamps within the window.
  const hits = new Map<string, number[]>();

  function recentFor(key: string, now: number): number[] {
    const cutoff = now - windowMs;
    const arr = hits.get(key);
    if (arr === undefined) return [];
    // Drop expired from the front (timestamps are pushed in order).
    let i = 0;
    while (i < arr.length && arr[i] <= cutoff) i++;
    const recent = i > 0 ? arr.slice(i) : arr;
    if (recent.length === 0) hits.delete(key);
    else hits.set(key, recent);
    return recent;
  }

  return {
    tryConsume(key, now) {
      const recent = recentFor(key, now);
      if (recent.length >= max) return false;
      recent.push(now);
      hits.set(key, recent);
      return true;
    },
    prune(now) {
      for (const key of [...hits.keys()]) recentFor(key, now);
    },
    size() {
      return hits.size;
    },
  };
}
