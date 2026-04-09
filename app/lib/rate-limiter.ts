// In-memory rate limiter factory
// Shared across routes (api.measurements, api.ab, etc.)
export function createRateLimiter(max: number, windowMs: number, cleanupMs: number) {
  const map = new Map<string, { count: number; resetAt: number }>();
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of map) {
      if (now > entry.resetAt) map.delete(key);
    }
  }, cleanupMs);
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
