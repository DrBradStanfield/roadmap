// Shared save-routing for the two timeline matrices (BloodTestTimeline +
// StartingInfoVitals). Both commit a set of per-date {metric → SI value}
// tasks; for each (date, metric) that ALREADY has an active row, the save must
// route through the FHIR correction flow (append a new active row + tombstone
// the old as `entered-in-error`, `corrects_id` set) instead of a plain INSERT —
// otherwise the partial-unique index (one active row per (user, metric, date))
// 409s and the typed value is silently cleared.
//
// Empty slot → INSERT (`onInsert`). Occupied slot (race / already-saved) →
// correction (`onCorrect`). One source of truth so the vitals backfill and the
// blood-test matrix can't drift on this collision policy.

import type { ApiMeasurement } from '@roadmap/health-core';

export interface SaveTask {
  date: string; // yyyy-mm-dd
  values: Record<string, number>; // metricType → SI value
}

export type CorrectFn = (
  oldId: string,
  newValueSI: number,
) => Promise<{ ok: true } | { ok: false; reason: 'conflict' | 'not_found' | 'error' }>;

/** Index the active row per (date, metric) from a flat history list. O(N). */
export function activeRowIndex(history: ApiMeasurement[]): Map<string, ApiMeasurement> {
  const index = new Map<string, ApiMeasurement>();
  for (const m of history) {
    if ((m.status ?? 'active') !== 'active') continue;
    const key = `${m.recordedAt.slice(0, 10)}|${m.metricType}`;
    if (!index.has(key)) index.set(key, m);
  }
  return index;
}

/**
 * Route each task's metrics to either a correction (slot occupied by an active
 * row) or a fresh insert (empty slot). Corrections for a task run in parallel;
 * inserts for a task batch into one `onInsert` call. Returns `{ failed }` =
 * true if any correction failed, so the caller can preserve the user's typed
 * draft for retry instead of clearing it.
 */
export async function routeTasksToSaves(
  tasks: SaveTask[],
  history: ApiMeasurement[],
  onInsert: (date: string, values: Record<string, number>) => Promise<void>,
  onCorrect?: CorrectFn,
): Promise<{ failed: boolean }> {
  const index = activeRowIndex(history);
  let failed = false;
  for (const t of tasks) {
    const corrections: Array<{ id: string; value: number }> = [];
    const newInserts: Record<string, number> = {};
    for (const [metric, value] of Object.entries(t.values)) {
      const existing = index.get(`${t.date}|${metric}`);
      if (existing && onCorrect) {
        corrections.push({ id: existing.id, value });
      } else {
        newInserts[metric] = value;
      }
    }
    if (corrections.length > 0 && onCorrect) {
      const results = await Promise.all(corrections.map(c => onCorrect(c.id, c.value)));
      if (results.some(r => !r.ok)) failed = true;
    }
    if (Object.keys(newInserts).length > 0) {
      await onInsert(t.date, newInserts);
    }
  }
  return { failed };
}
