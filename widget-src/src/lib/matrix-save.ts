// The one routing rule for typed values (US-03 AC2, AC3), stated here and
// nowhere else. The first-time vitals fields and both matrices
// (BloodTestTimeline, StartingInfoVitals) save through HealthTool, which
// routes every cell here against the store's own rows, read as it writes:
//   - each cell names the row it expects under each slot: the one the page
//     showed when the user began typing there, or none. A slot holding any
//     other row by now (another device, a connector; the page can show an
//     older record than the store holds) writes nothing of the cell, a blood
//     pressure's halves alike, and answers `changed`;
//   - an empty slot is an insert (`onInsert`);
//   - the row expected is corrected (`onCorrect`: a new active row with
//     `correctsId`, the old one flipped to `entered-in-error`);
//   - a value that changes nothing (`sameAsSaved`, in the unit it was typed
//     in) writes nothing;
//   - every write's answer is read, slot by slot: the caller keeps what was
//     refused, with why, and only that (US-03 AC4);
//   - one write per (day, metric), the later cell's. A safety net only: a
//     matrix never sends two values for one slot, it shows them as an error.

import { formatDisplayValue, fromCanonicalValue, type ApiMeasurement, type MetricType, type UnitSystem } from '@roadmap/health-core';
import { sameAsSaved } from './blood-test-cell';
import type { CorrectStatus } from '../storage/roadmap-store';

/** One cell's values on its day: one test, or a blood pressure's halves. */
export interface SaveTask {
  date: string; // yyyy-mm-dd
  values: Record<string, number>; // metricType → SI value
  /** By metric, the row the cell expects to replace: its id, or null for an
   *  empty slot. A metric left out expects an empty slot. */
  expected: Record<string, string | null>;
  /** The unit the values were typed in. */
  unit: UnitSystem;
}

/** Correct one saved value, core or lab; `newValue` is in the unit it is stored in. */
export type CorrectFn = (id: string, newValue: number) => Promise<CorrectStatus>;

/** The values a save refused, by slot (`slotOf`), and why. Empty: every
 *  value landed or changed nothing. */
export type Refused = Map<string, Exclude<CorrectStatus, 'ok'>>;

/** A (day, metric) slot, as `Refused` and `activeRowIndex` key it. */
export const slotOf = (date: string, metric: string) => `${date}|${metric}`;

/** Index the active row per (date, metric) from a flat history list. O(N). */
export function activeRowIndex(history: ApiMeasurement[]): Map<string, ApiMeasurement> {
  const index = new Map<string, ApiMeasurement>();
  for (const m of history) {
    if ((m.status ?? 'active') !== 'active') continue;
    const key = slotOf(m.recordedAt.slice(0, 10), m.metricType);
    if (!index.has(key)) index.set(key, m);
  }
  return index;
}

/**
 * Save `tasks` by the rule above. `history` is the store's rows, read just
 * before this call, never the page's copy. `onInsert` answers as the store
 * does.
 */
export async function routeTasksToSaves(
  tasks: SaveTask[],
  history: ApiMeasurement[],
  onInsert: (date: string, metric: string, value: number) => Promise<CorrectStatus>,
  onCorrect: CorrectFn,
): Promise<Refused> {
  const index = activeRowIndex(history);
  const slots = new Map<string, { task: SaveTask; metric: MetricType } | 'changed'>();
  for (const task of tasks) {
    const metrics = Object.keys(task.values);
    const changed = metrics.some((metric) => (index.get(slotOf(task.date, metric))?.id ?? null) !== (task.expected[metric] ?? null));
    for (const metric of metrics) slots.set(slotOf(task.date, metric), changed ? 'changed' : { task, metric: metric as MetricType });
  }
  const refused: Refused = new Map();
  await Promise.all([...slots].map(async ([key, slot]) => {
    if (slot === 'changed') { refused.set(key, 'changed'); return; }
    const { task: { date, values, unit }, metric } = slot;
    const value = values[metric];
    const held = index.get(key);
    const status = !held ? await onInsert(date, metric, value)
      : sameAsSaved(fromCanonicalValue(metric, value, unit), formatDisplayValue(metric, held.value, unit), value, held.value) ? 'ok'
      : await onCorrect(held.id, value);
    if (status !== 'ok') refused.set(key, status);
  }));
  return refused;
}
