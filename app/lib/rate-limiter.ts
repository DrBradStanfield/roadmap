// In-memory rate limiter factory
// Shared across routes (api.measurements, api.ab, etc.)
export const DAY_MS = 24 * 60 * 60_000;

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
  // `reset` is a test seam: the map is process-global and would otherwise leak
  // between cases in a suite that drives a limited route many times.
  return Object.assign(
    (key: string): boolean => {
      const now = Date.now();
      const entry = map.get(key);
      if (!entry || now > entry.resetAt) {
        map.set(key, { count: 1, resetAt: now + windowMs });
        return true;
      }
      entry.count++;
      return entry.count <= max;
    },
    { reset: () => map.clear() },
  );
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
    /** Test seam — the map is process-global. */
    reset: () => map.clear(),
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
    /** Hand `n` units back — a file charged before a model call that never got to run (US-35 AC10). */
    refund(key: string, n: number): void {
      const entry = live(key);
      if (entry) entry.count = Math.max(0, entry.count - n);
    },
    remaining(key: string): number {
      const entry = live(key);
      return Math.max(0, limit - (entry?.count ?? 0));
    },
  };
}

const DEFAULT_DAILY_FILE_CAP = 2000;

/**
 * The per-machine daily file cap — the dollar ceiling on extraction. Spent by
 * the website's upload route and the connector's `import_documents` alike
 * (US-35 AC10), so the ceiling stays ONE number. In memory, so the true cap is
 * `AI_DAILY_FILE_CAP × machines × 2 apps` and it resets on deploy — an
 * accepted approximation until a shared counter is worth its DDL.
 */
export const machineFiles = createQuotaCounter(dailyFileCap(process.env.AI_DAILY_FILE_CAP), DAY_MS, 30 * 60_000);

/**
 * AI_DAILY_FILE_CAP as a number. A value that is not a finite number of 0 or
 * more ("2,000", one that kept an inline comment) falls back to the default
 * 2000 and says so in the log: a bare Number() made it NaN, `count + n > NaN`
 * is never true, and the machine's $-ceiling was gone (SE-4). The same rule
 * as `num()` in app-gate.server.ts, which reads this variable for the app's
 * lab cap, so the two readers agree.
 */
export function dailyFileCap(raw: string | undefined, warn: (message: string) => void = console.warn): number {
  return envCap('AI_DAILY_FILE_CAP', raw, DEFAULT_DAILY_FILE_CAP, warn);
}

/** `dailyFileCap`'s rule for any cap read from the env: unset is `fallback`, 0 is 0, a non-number warns and is `fallback`. */
export function envCap(name: string, raw: string | undefined, fallback: number, warn: (message: string) => void = console.warn): number {
  if (!raw) return fallback;
  const value = Number(raw);
  if (Number.isFinite(value) && value >= 0) return value;
  warn(`${name} is not a number of 0 or more, so the default ${fallback} applies.`);
  return fallback;
}

/**
 * Web chat turns a day (US-15 AC45, Brad's numbers 2026-10-31): 200 per shopper
 * IP, as the iPhone app's per-IP chat limit, and `WEB_CHAT_DAILY_CAP` (default
 * 10,000) per machine, high enough that a few addresses cannot use it to switch
 * web chat off, low enough to bound a runaway bill. In
 * memory, so both are per machine (an IP behind N machines can get 200 × N)
 * and reset on deploy or when the machine stops, as `machineFiles`. Exported
 * as a test seam.
 */
export const webChatTurns = {
  ip: createQuotaCounter(200, DAY_MS, 30 * 60_000),
  machine: createQuotaCounter(envCap('WEB_CHAT_DAILY_CAP', process.env.WEB_CHAT_DAILY_CAP, 10_000), DAY_MS, 30 * 60_000),
};

/** Count one web chat turn; false when the IP or the machine is at its cap. A refused turn costs neither: an IP at its cap spends none of the machine's, and a turn the machine refuses is handed back to the IP. */
export function takeWebChatTurn(ipBucket: string): boolean {
  if (!webChatTurns.ip.take(ipBucket, 1)) return false;
  if (webChatTurns.machine.take('machine', 1)) return true;
  webChatTurns.ip.refund(ipBucket, 1);
  return false;
}
