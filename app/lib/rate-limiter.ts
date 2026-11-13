// In-memory rate limiter factory
// Shared across routes (api.measurements, api.ab, etc.)
import * as Sentry from '@sentry/react-router';

export const DAY_MS = 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;

/**
 * The one expiry rule for the server's in-memory TTL maps (S-19): an entry is
 * live until its expiry instant, not at it, so a window of W ms is W ms long.
 */
export const isLive = (expiresAt: number, now: number): boolean => now < expiresAt;

/**
 * Keys per limiter map (S-19). An entry measured about 180 bytes (an IPv6 /64
 * key and its count), so a full map is about 9 MB, and the 36 limiter maps all
 * full at once stay near a third of a machine's 1 GB (fly.toml).
 */
export const MAX_TRACKED_KEYS = 50_000;

/**
 * The one sweep for the server's in-memory TTL maps (S-5): every `everyMs`,
 * delete each entry that is no longer live. It only bounds memory; each reader
 * still checks expiry itself, so nothing is served past it between sweeps.
 * Unref'd: never holds the process open just to sweep. Returns its timer.
 */
export function sweepExpired<V>(map: Map<string, V>, expiresAt: (entry: V) => number, everyMs: number): ReturnType<typeof setInterval> {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of map) if (!isLive(expiresAt(entry), now)) map.delete(key);
  }, everyMs);
  timer.unref?.();
  return timer;
}

/**
 * A bounded map's name (the only thing its full-map warning says) and its bound. `maxKeys: Infinity`
 * leaves a map unbounded, for a set whose entries must hold for their whole life (the spent challenges).
 */
export interface LimitMapOptions { name: string; maxKeys?: number }

/**
 * The bound on one TTL map: `room(key, now)` clears `key` and makes room for it. Each map has one
 * TTL and every write goes through here before its set, so insertion order is expiry order: expired
 * entries leave from the front first, then the oldest live entry. A caller who can make many keys
 * already gets a fresh count per key, the machine-wide caps still bind, and refusing would lock real
 * new callers out. A map that has to evict a live entry warns once an hour, by its name alone.
 */
export function boundedMap<V>(map: Map<string, V>, expiresAt: (entry: V) => number, options: LimitMapOptions) {
  const maxKeys = options.maxKeys ?? MAX_TRACKED_KEYS;
  let warnedAt = -Infinity;
  return (key: string, now: number): void => {
    map.delete(key);
    for (const [oldest, entry] of map) {
      if (map.size < maxKeys || isLive(expiresAt(entry), now)) break;
      map.delete(oldest);
    }
    if (map.size < maxKeys) return;
    if (now - warnedAt >= HOUR_MS) {
      warnedAt = now;
      // Fixed text and the map's name only: never a key, an IP or anyone's count.
      console.error(`In-memory limit map full: ${options.name}`);
      Sentry.captureMessage('In-memory limit map full', { level: 'warning', tags: { feature: 'rate_limit', map: options.name } });
    }
    map.delete(map.keys().next().value!);
  };
}

const resetAtOf = (entry: { resetAt: number }) => entry.resetAt;

export function createRateLimiter(max: number, windowMs: number, cleanupMs: number, options: LimitMapOptions) {
  const map = new Map<string, { count: number; resetAt: number }>();
  sweepExpired(map, resetAtOf, cleanupMs);
  const room = boundedMap(map, resetAtOf, options);
  // `reset` is a test seam: the map is process-global and would otherwise leak
  // between cases in a suite that drives a limited route many times.
  return Object.assign(
    (key: string): boolean => {
      const now = Date.now();
      const entry = map.get(key);
      if (!entry || !isLive(entry.resetAt, now)) {
        room(key, now);
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
export function createQuotaCounter(limit: number, windowMs: number, cleanupMs: number, options: LimitMapOptions) {
  const map = new Map<string, { count: number; resetAt: number }>();
  sweepExpired(map, resetAtOf, cleanupMs);
  const room = boundedMap(map, resetAtOf, options);
  const live = (key: string) => {
    const entry = map.get(key);
    return entry && isLive(entry.resetAt, Date.now()) ? entry : null;
  };
  const charge = (key: string, n: number) => {
    if (n > limit) return null; // refused before it takes a place (US-52 AC4i)
    let entry = live(key);
    if (!entry) {
      room(key, Date.now());
      entry = { count: 0, resetAt: Date.now() + windowMs };
      map.set(key, entry);
    }
    if (entry.count + n > limit) return null;
    entry.count += n;
    return entry;
  };
  return {
    /** Test seam — the map is process-global. */
    reset: () => map.clear(),
    /** Consume `n` units; false (and nothing consumed) when it would exceed the limit. */
    take: (key: string, n: number): boolean => charge(key, n) !== null,
    /**
     * Like take, but returns the refund for this charge alone, or null when refused.
     * The refund is bound to the window it charged: once that window has expired
     * it does nothing, so a request pending across the expiry cannot reopen the next (US-52 AC4a).
     */
    reserve(key: string, n: number): (() => void) | null {
      const entry = charge(key, n);
      return entry && (() => { if (live(key) === entry) entry.count = Math.max(0, entry.count - n); });
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
export const machineFiles = createQuotaCounter(dailyFileCap(process.env.AI_DAILY_FILE_CAP), DAY_MS, 30 * 60_000, { name: 'machine files per day' });

/**
 * AI_DAILY_FILE_CAP as a number. A value that is not a finite number of 0 or
 * more ("2,000", one that kept an inline comment) falls back to the default
 * 2000 and says so in the log: a bare Number() made it NaN, `count + n > NaN`
 * is never true, and the machine's $-ceiling was gone (SE-4). app-gate.server.ts
 * reads this variable for the app's lab cap through this same function, so the
 * two readers agree (US-52 AC4e).
 */
export function dailyFileCap(raw: string | undefined, warn: (message: string) => void = console.warn): number {
  return envCap('AI_DAILY_FILE_CAP', raw, DEFAULT_DAILY_FILE_CAP, warn);
}

/**
 * `dailyFileCap`'s rule for any cap read from the env: unset or empty is `fallback`, 0 is 0, a non-number warns and
 * is `fallback`. Only whitespace is a non-number: Number('  ') is 0, which would switch the cap off (S-18).
 */
export function envCap(name: string, raw: string | undefined, fallback: number, warn: (message: string) => void = console.warn): number {
  if (!raw) return fallback;
  const value = raw.trim() ? Number(raw) : NaN;
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
  ip: createQuotaCounter(200, DAY_MS, 30 * 60_000, { name: 'web chat turns per IP' }),
  machine: createQuotaCounter(envCap('WEB_CHAT_DAILY_CAP', process.env.WEB_CHAT_DAILY_CAP, 10_000), DAY_MS, 30 * 60_000, { name: 'web chat turns per machine' }),
};

/**
 * Count one web chat turn; false when the IP or the machine is at its cap. A refused turn costs neither: an IP at
 * its cap spends none of the machine's, and a turn the machine refuses never touches the IP's count or its clock.
 * A refund would hand back the count but not the clock, so a refused turn would start the IP's 24 hours and let it
 * spend 200 when the machine resets and 200 more when that early window ends. Synchronous, so the check holds.
 */
export function takeWebChatTurn(ipBucket: string): boolean {
  if (webChatTurns.ip.remaining(ipBucket) < 1) return false;
  return webChatTurns.machine.take('machine', 1) && webChatTurns.ip.take(ipBucket, 1);
}
