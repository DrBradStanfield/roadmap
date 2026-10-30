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

import { pressureInverted, type ApiMeasurement, type MetricType } from '@roadmap/health-core';
import { cellFromSI, cellText, sameAsSaved, type CellUnit } from './blood-test-cell';
import type { CorrectStatus } from '../storage/roadmap-store';

/** One cell's values on its day: one test, or a blood pressure's halves. */
export interface SaveTask {
  date: string; // yyyy-mm-dd
  values: Record<string, number>; // metricType → SI value
  /** By metric, the row the cell expects to replace: its id, or null for an
   *  empty slot. A metric left out expects an empty slot. */
  expected: Record<string, string | null>;
  /** The unit the values were typed in (an Lp(a) cell's own unit, US-05 AC2). */
  unit: CellUnit;
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
  const slots = new Map<string, { task: SaveTask; metric: MetricType } | 'changed' | 'invalid'>();
  for (const task of tasks) {
    const metrics = Object.keys(task.values);
    const changed = metrics.some((metric) => (index.get(slotOf(task.date, metric))?.id ?? null) !== (task.expected[metric] ?? null));
    // US-02 AC8: a blood pressure leaves its day's pair (typed, else saved) the right way up.
    // One half on a day already inverted is let through, as the record lets it through,
    // so the day can be fixed one half at a time; a typed pair must be right way up.
    const saved = (metric: string) => index.get(slotOf(task.date, metric))?.value;
    const half = (metric: string) => task.values[metric] ?? saved(metric);
    const both = 'systolic_bp' in task.values && 'diastolic_bp' in task.values;
    const inverted = metrics.some((metric) => metric.endsWith('_bp')) && pressureInverted(half('systolic_bp'), half('diastolic_bp'))
      && (both || !pressureInverted(saved('systolic_bp'), saved('diastolic_bp')));
    // Writes run in slot order, each one done before the next starts (the store is
    // synchronous): a lower bottom number first, so neither half alone inverts the pair.
    const heldDia = saved('diastolic_bp');
    if (heldDia !== undefined && task.values.diastolic_bp < heldDia) metrics.sort((a, b) => Number(b === 'diastolic_bp') - Number(a === 'diastolic_bp'));
    for (const metric of metrics) {
      slots.set(slotOf(task.date, metric), changed ? 'changed' : inverted && metric.endsWith('_bp') ? 'invalid' : { task, metric: metric as MetricType });
    }
  }
  const refused: Refused = new Map();
  await Promise.all([...slots].map(async ([key, slot]) => {
    if (slot === 'changed' || slot === 'invalid') { refused.set(key, slot); return; }
    const { task: { date, values, unit }, metric } = slot;
    const value = values[metric];
    const held = index.get(key);
    const status = !held ? await onInsert(date, metric, value)
      : sameAsSaved(cellFromSI(metric, value, unit), cellText(metric, held.value, unit), value, held.value) ? 'ok'
      : await onCorrect(held.id, value);
    if (status !== 'ok') refused.set(key, status);
  }));
  return refused;
}
