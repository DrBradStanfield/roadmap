/**
 * Measurement recency. Two resolvers with different contracts: the dated
 * history a chat surface ships to a model, and the newest ACTIVE row per
 * metric the plan is computed from (`latestActivePerMetric`, US-07 AC4).
 *
 * The dated history is shared by every surface that ships the time series:
 *
 *   - HealthTool (Shopify v2 storefront) builds it client-side and sends it
 *     as guestInputs.measurementHistory to Brad's server
 *   - chat.server.ts derives "most recent per field" from it after sanitizing
 *   - byok-chat (GitHub Pages / self-host) builds AND consumes it client-side
 *
 * The dated series is the source of truth for "most recent X": the single
 * snapshot field a client reports can be ambiguous (it once reported LDL 2.0
 * where the newest dated lab was 1.2), so callers override their snapshot
 * values with latestFromHistory().
 */
import { METRIC_TO_FIELD } from './mappings';
import type { HealthInputs } from './types';
import { comparatorOf, type Comparator } from './lab-limits';
import { stampInstant } from './merge';
import { UNIT_DEFS } from './units';

export interface DatedMeasurement {
  /** YYYY-MM-DD */
  date: string;
  /** SI value, same units as the corresponding HealthInputs field */
  value: number;
  /** A lab result printed as a limit: `value` is its bound, not the result (US-12 AC20). */
  comparator?: Comparator;
  /** An unsaved creatinine the client's plan read (US-07 AC7): the server takes its day, then drops it. */
  draft?: true;
}

/** A client's draft point (US-07 AC7): the marker counts only as `draft: true`; anything else is a saved point. */
export const isDraftPoint = (p: unknown): boolean => !!p && typeof p === 'object' && (p as { draft?: unknown }).draft === true;

/** Per-metric chronological series — the LAST entry is the most recent. */
export type MeasurementHistoryMap = Record<string, DatedMeasurement[]>;

/** Newest points kept per metric — bounds the chat payload + prompt size. */
export const HISTORY_CAP_PER_METRIC = 24;

/** What counts as a valid dated point — shared with the server-side sanitizer. */
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A YYYY-MM-DD the calendar has. `Date.parse` alone takes 2026-02-30 and rolls it to 2 March. */
export function isCalendarDay(day: string): boolean {
  return ISO_DATE.test(day) && !Number.isNaN(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day;
}

/** A stored row's `recordedAt` the reader keeps: it starts with a real calendar day (US-29 AC4a). */
export function isClinicalDay(recordedAt: unknown): recordedAt is string {
  return typeof recordedAt === 'string' && isCalendarDay(recordedAt.slice(0, 10));
}

/**
 * Group raw measurement records into the chat-context history map: keyed by
 * metricType, sorted oldest→newest, capped at the newest `cap` points per
 * metric. Records without a valid YYYY-MM-DD recordedAt are dropped.
 */
export function buildMeasurementHistory(
  records: Array<{ metricType: string; value: number; recordedAt?: string | null; comparator?: Comparator; id?: string; createdAt?: string }>,
  cap = HISTORY_CAP_PER_METRIC,
  now = new Date(),
): MeasurementHistoryMap {
  const out: MeasurementHistoryMap = {};
  // A PSA the plan cannot use never takes a place under the cap, so newer
  // unusable rows cannot push out the one the chat's plan reads (US-06 AC14).
  const latestDay = latestDayOnEarth(now);
  // Within one day, the order `latestActivePerMetric` ranks by (time, then
  // createdAt, then id), so a day's last point is the row the plan reads (US-06 AC14).
  const key = (r: (typeof records)[number]) => [r.recordedAt ?? '', r.createdAt ?? '', r.id ?? ''];
  const ranked = [...records].sort((a, b) => {
    const [x, y] = [key(a), key(b)];
    const i = x.findIndex((v, n) => v !== y[n]);
    return i < 0 ? 0 : x[i] < y[i] ? -1 : 1;
  });
  for (const r of ranked) {
    const date = (r.recordedAt || '').slice(0, 10);
    if (!ISO_DATE.test(date) || (r.metricType === 'psa' && !usablePsa(r, latestDay))) continue;
    (out[r.metricType] ??= []).push({ date, value: r.value, ...comparatorOf(r) });
  }
  for (const k of Object.keys(out)) {
    out[k].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    if (out[k].length > cap) out[k] = out[k].slice(-cap);
  }
  return out;
}

/**
 * The latest calendar day anywhere on Earth at `now` (UTC+14). A server runs
 * in UTC, so a day the person has already reached can be its tomorrow; the
 * old screening answers allowed the same (US-06 AC14).
 */
const latestDayOnEarth = (now: Date) => new Date(now.getTime() + 14 * 3600_000).toISOString().slice(0, 10);

/** A PSA point the plan can use: in the PSA range, on a real day not after `latestDay`. */
const usablePsa = (r: { value: number; recordedAt?: string | null }, latestDay: string) => {
  const { min, max } = UNIT_DEFS.psa.validationRange.si;
  return r.value >= min && r.value <= max && isClinicalDay(r.recordedAt) && r.recordedAt.slice(0, 10) <= latestDay;
};

/**
 * US-06 AC14: the saved PSA the plan, the reminders, the web form and the
 * chat all read. Among the active `psa` rows, those `usablePsa` keeps at
 * `now` (the caller's clock), the newest by `latestActivePerMetric`'s rule.
 * An unusable newer row never hides an older usable one.
 */
export function newestUsablePsa<
  T extends { id: string; metricType: string; value: number; recordedAt: string; createdAt?: string; status?: string },
>(rows: readonly T[], now: Date): T | undefined {
  const latestDay = latestDayOnEarth(now);
  return latestActivePerMetric(rows.filter((r) => r.metricType === 'psa' && usablePsa(r, latestDay)))[0];
}

/**
 * The newest ACTIVE row per metricType — what "my current value" means wherever
 * the plan is computed (US-07 AC4). Recency is the UTC instant of `recordedAt`, not
 * file order: a file holds every reading, ordered by insertion on one device and
 * by uuid after a merge, so a backfilled 2024 lab would otherwise outrank a 2026
 * one. `createdAt` then `id` break ties, so every device picks the same winner.
 *
 * Returns rows (callers need `id`/`recordedAt`); `measurementsToInputs` is the
 * separate rows-to-fields step.
 */
export function latestActivePerMetric<
  T extends { id: string; metricType: string; recordedAt: string; createdAt?: string; status?: string },
>(rows: T[]): T[] {
  const best = new Map<string, T>();
  for (const r of rows) {
    if (r.status !== undefined && r.status !== 'active') continue;
    const held = best.get(r.metricType);
    if (!held || beats(r, held)) best.set(r.metricType, r);
  }
  return [...best.values()];
}

/**
 * -1, 0 or 1: which recorded time is later as a UTC instant (US-07 AC4, Brad
 * 2026-11-03: "whichever one comes later in UTC"). A date-only day is 00:00 UTC,
 * as `stampInstant` and merge read it. Two spellings of one instant are a tie.
 * When either does not parse, the text order decides, as it did before.
 */
export function compareRecordedAt(a: string, b: string): number {
  const [ta, tb] = [stampInstant(a), stampInstant(b)];
  if (Number.isNaN(ta) || Number.isNaN(tb)) return a < b ? -1 : a > b ? 1 : 0;
  return Math.sign(ta - tb);
}

function beats(
  a: { id: string; recordedAt: string; createdAt?: string },
  b: { id: string; recordedAt: string; createdAt?: string },
): boolean {
  const order = compareRecordedAt(a.recordedAt, b.recordedAt);
  if (order !== 0) return order > 0;
  const ac = a.createdAt ?? '';
  const bc = b.createdAt ?? '';
  if (ac !== bc) return ac > bc;
  return a.id > b.id;
}

/** A series' newest point (the last: a series runs oldest first), or none when it is printed as a limit (US-12 AC20). */
export function newestExactPoint(series: DatedMeasurement[] | undefined): DatedMeasurement | undefined {
  const newest = series?.[series.length - 1];
  return newest && !newest.comparator ? newest : undefined;
}

/**
 * The most recent dated reading per HealthInputs field (via METRIC_TO_FIELD).
 * Metrics with no field mapping are skipped. Callers merge this over their
 * snapshot so the reported value and the trend always agree.
 */
export function latestFromHistory(
  history: MeasurementHistoryMap,
): Partial<Record<keyof HealthInputs, number>> {
  const out: Partial<Record<keyof HealthInputs, number>> = {};
  for (const [metric, series] of Object.entries(history)) {
    const field = METRIC_TO_FIELD[metric];
    const newest = newestExactPoint(series);
    if (field && newest) out[field] = newest.value;
  }
  return out;
}
