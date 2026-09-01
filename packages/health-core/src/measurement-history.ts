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

export interface DatedMeasurement {
  /** YYYY-MM-DD */
  date: string;
  /** SI value, same units as the corresponding HealthInputs field */
  value: number;
}

/** Per-metric chronological series — the LAST entry is the most recent. */
export type MeasurementHistoryMap = Record<string, DatedMeasurement[]>;

/** Newest points kept per metric — bounds the chat payload + prompt size. */
export const HISTORY_CAP_PER_METRIC = 24;

/** What counts as a valid dated point — shared with the server-side sanitizer. */
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Group raw measurement records into the chat-context history map: keyed by
 * metricType, sorted oldest→newest, capped at the newest `cap` points per
 * metric. Records without a valid YYYY-MM-DD recordedAt are dropped.
 */
export function buildMeasurementHistory(
  records: Array<{ metricType: string; value: number; recordedAt?: string | null }>,
  cap = HISTORY_CAP_PER_METRIC,
): MeasurementHistoryMap {
  const out: MeasurementHistoryMap = {};
  for (const r of records) {
    const date = (r.recordedAt || '').slice(0, 10);
    if (!ISO_DATE.test(date)) continue;
    (out[r.metricType] ??= []).push({ date, value: r.value });
  }
  for (const k of Object.keys(out)) {
    out[k].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    if (out[k].length > cap) out[k] = out[k].slice(-cap);
  }
  return out;
}

/**
 * The newest ACTIVE row per metricType — what "my current value" means wherever
 * the plan is computed (US-07 AC4). Recency is clinical date (`recordedAt`), not
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

function beats(
  a: { id: string; recordedAt: string; createdAt?: string },
  b: { id: string; recordedAt: string; createdAt?: string },
): boolean {
  if (a.recordedAt !== b.recordedAt) return a.recordedAt > b.recordedAt;
  const ac = a.createdAt ?? '';
  const bc = b.createdAt ?? '';
  if (ac !== bc) return ac > bc;
  return a.id > b.id;
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
    if (field && series.length > 0) out[field] = series[series.length - 1].value;
  }
  return out;
}
