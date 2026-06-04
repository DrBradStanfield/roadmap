/** Resolve after `ms` milliseconds. Used for retry backoff, polling intervals, etc. */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Reject after `timeoutMs` if `promise` hasn't settled, with an attached label.
 *
 * Accepts `PromiseLike<T>` so Supabase's query builder (a thenable, not a real
 * Promise) can be passed directly without an extra .then(x => x) wrap.
 */
export function withTimeout<T>(promise: PromiseLike<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

const NZ_TIMEZONE = 'Pacific/Auckland';

/**
 * Current NZ-local hour (0-23) and date (YYYY-MM-DD) at `now`.
 *
 * DST-aware via `Intl.DateTimeFormat` — handles the NZST (UTC+12) ↔ NZDT
 * (UTC+13) transitions transparently. Both hour and date follow NZ
 * wall-clock, so a cron's lock_date matches NZ midnight (not UTC midnight)
 * and an NZ-afternoon catch-up run can't clash with the next morning's
 * scheduled run via the same UTC date.
 */
export function nzNowParts(now: Date = new Date()): { hour: number; dateStr: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: NZ_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) => parts.find(p => p.type === type)!.value;
  // Intl can emit hour '24' at midnight in some locales; normalise to 0.
  const hourRaw = parseInt(get('hour'), 10);
  return {
    hour: hourRaw === 24 ? 0 : hourRaw,
    dateStr: `${get('year')}-${get('month')}-${get('day')}`,
  };
}
