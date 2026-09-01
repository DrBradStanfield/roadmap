// In-memory rate limiter factory
// Shared across routes (api.measurements, api.ab, etc.)
export function createRateLimiter(max: number, windowMs: number, cleanupMs: number) {
  const map = new Map<string, { count: number; resetAt: number }>();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of map) {
      if (now > entry.resetAt) map.delete(key);
    }
  }, cleanupMs);
  // Never hold the process open just to sweep an in-memory map.
  sweep.unref?.();
  return (key: string): boolean => {
    const now = Date.now();
    const entry = map.get(key);
    if (!entry || now > entry.resetAt) {
      map.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    entry.count++;
    return entry.count <= max;
  };
}

/**
 * Weighted per-key quota over a sliding window (e.g. "N files per IP per
 * day"). Same Map+sweep machinery as createRateLimiter, but consumption has a
 * weight and callers can read the remainder without consuming.
 */
export function createQuotaCounter(limit: number, windowMs: number, cleanupMs: number) {
  const map = new Map<string, { count: number; resetAt: number }>();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of map) {
      if (now > entry.resetAt) map.delete(key);
    }
  }, cleanupMs);
  // Never hold the process open just to sweep an in-memory map.
  sweep.unref?.();
  const live = (key: string) => {
    const entry = map.get(key);
    return entry && Date.now() <= entry.resetAt ? entry : null;
  };
  return {
    /** Consume `n` units; false (and nothing consumed) when it would exceed the limit. */
    take(key: string, n: number): boolean {
      let entry = live(key);
      if (!entry) {
        entry = { count: 0, resetAt: Date.now() + windowMs };
        map.set(key, entry);
      }
      if (entry.count + n > limit) return false;
      entry.count += n;
      return true;
    },
    remaining(key: string): number {
      const entry = live(key);
      return Math.max(0, limit - (entry?.count ?? 0));
    },
  };
}
