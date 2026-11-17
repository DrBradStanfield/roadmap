// The single-topic widgets' height, weight and waist (US-74): what the record
// holds, the save and the results. Every rule here is the full app's own: the
// store's profile save, the one routing rule for a day's value
// (lib/matrix-save.ts via saveTasksToStore), its flush, and health-core's plan
// and tiles. This file only joins them for three boxes; boxes.ts reads them.
import { calculateHealthResults } from '@roadmap/health-core/calculations';
import { localDay } from '@roadmap/health-core/merge';
import { rowTarget } from '@roadmap/health-core/row-target';
import { statTiles, type StatTile } from '@roadmap/health-core/stat-tiles';
import type { HealthInputs } from '@roadmap/health-core/types';
import { detectUnitSystem, type UnitSystem } from '@roadmap/health-core/units';
import { saveTasksToStore } from '../hooks/useLongitudinalSave';
import { activeRowIndex, slotOf, type SaveTask } from '../lib/matrix-save';
import {
  correctValue, currentSaveStatus, flushRoadmapStore, getBackendKind, getInitialInputsSync, getShownErase,
  loadAllHistorySync, loadLatestMeasurementsSync, saveChangedMeasurements,
} from '../lib/roadmap-data';
import { healthWritesAllowed, loadUnitPreference } from '../lib/storage';
import { INPUT_OF, type Field, type Measured } from './boxes';

/** The two day-slotted values the widget saves. */
const DAY_FIELDS = ['weight', 'waist'] as const;
type DayField = (typeof DAY_FIELDS)[number];

/** What the person has seen of the record: the height the box showed, and
 *  today's row per day value the boxes showed. A save may replace only these;
 *  it never adopts a row or height the person has not seen (review A4). */
export interface Seen { heightCm?: number; today: Record<DayField, string | null> }

/** The units the boxes start in (US-74 AC2): the record's, else the full app's own default. */
export function startingUnits(): UnitSystem {
  return getInitialInputsSync().unitSystem ?? loadUnitPreference() ?? detectUnitSystem();
}

/** The record's height, and its latest active weight and waist (US-74 AC2): the plan's own inputs for them. */
export function recordMeasured(): Measured {
  const latest = loadLatestMeasurementsSync();
  const rowOf = (metric: DayField) => latest?.previousMeasurements.find((m) => m.metricType === metric)?.value;
  const out: Measured = {};
  const heightCm = getInitialInputsSync().heightCm;
  if (heightCm !== undefined) out.heightCm = heightCm;
  const weightKg = rowOf('weight'), waistCm = rowOf('waist');
  if (weightKg !== undefined) out.weightKg = weightKg;
  if (waistCm !== undefined) out.waistCm = waistCm;
  return out;
}

/** Today's active rows, as the store holds them now. */
function todaysRowsNow(): Map<DayField, { id: string; value: number }> {
  const index = activeRowIndex(loadAllHistorySync());
  const today = localDay(new Date());
  const out = new Map<DayField, { id: string; value: number }>();
  for (const field of DAY_FIELDS) {
    const row = index.get(slotOf(today, field));
    if (row) out.set(field, { id: row.id, value: row.value });
  }
  return out;
}

/** The record as the boxes now show it: everything in it is seen. */
export function seenNow(): Seen {
  const rows = todaysRowsNow();
  return { heightCm: getInitialInputsSync().heightCm, today: { weight: rows.get('weight')?.id ?? null, waist: rows.get('waist')?.id ?? null } };
}

/** What the plan reads from the record (US-74 AC3): its tiles for the
 *  waist-to-height ratio and BMI, and the waist target line. */
export interface Results {
  /** The plan's waist-to-height tile; absent with no waist on record. */
  whtr?: StatTile;
  /** The plan's BMI tile, its status the composite assessment's; absent with no weight on record. */
  bmi?: StatTile;
  /** The full app's waist target line ("Target: <89 cm"), which needs only the height. */
  target: string;
}

/** The plan's results for these values over the record's profile (sex, birth
 *  date): the same function and tiles the full app's plan runs. */
export function resultsFor(values: Measured & { heightCm: number }, system: UnitSystem): Results {
  const { sex, birthYear, birthMonth } = getInitialInputsSync();
  const inputs: HealthInputs = { sex, birthYear, birthMonth, ...values };
  const tiles = statTiles(calculateHealthResults(inputs, system), { unitSystem: system, sex });
  const target = rowTarget('waist', system, null, { heightCm: values.heightCm })!.full;
  return { whtr: tiles.find((t) => t.key === 'whtr'), bmi: tiles.find((t) => t.key === 'bmi'), target };
}

/** The plan's results for the record as it is now, so the widget never shows
 *  a grade the plan would not (review A2). Null with no height on record. */
export function recordResults(system: UnitSystem): Results | null {
  const values = recordMeasured();
  return values.heightCm === undefined ? null : resultsFor({ ...values, heightCm: values.heightCm }, system);
}

/**
 * How a save ended. `stored`: the store kept the record (or its device copy,
 * its documented fallback), or nothing needed writing. `saved`: the entries
 * written. `changed`: entries not written because the record moved under the
 * person (another tab or device). `refused`: entries the store would not
 * take. `failed`: the store could not keep the record.
 */
export type SaveOutcome =
  | { kind: 'stored'; saved: Field[]; changed: Field[]; refused: Field[] }
  | { kind: 'failed' };

/**
 * Save what the person entered (US-74 AC4), never a value only filled from
 * the record (review A1): a height to the profile by the store's profile save,
 * a weight and a waist as today's values through the full app's own save.
 * Each replaces only what the person saw (`seen`, review A4). Then wait for
 * the store to keep it (review A3). `values` hold no errors (readBoxes).
 */
export async function saveMeasured(values: Measured, entered: Set<Field>, seen: Seen): Promise<SaveOutcome> {
  if (getBackendKind() === 'local' && !healthWritesAllowed()) return { kind: 'failed' };
  const erase = getShownErase();
  const saved: Field[] = [], changed: Field[] = [], refused: Field[] = [];
  if (entered.has('height') && values.heightCm !== undefined) {
    const recorded = getInitialInputsSync().heightCm;
    if (recorded !== seen.heightCm) changed.push('height');
    else if (values.heightCm === recorded) saved.push('height');
    else {
      const profile = await saveChangedMeasurements({ heightCm: values.heightCm }, { heightCm: recorded }, erase);
      if (!profile.ok) return { kind: 'failed' };
      (profile.refused ? refused : saved).push('height');
    }
  }
  const today = localDay(new Date());
  const tasks: SaveTask[] = DAY_FIELDS.flatMap((field): SaveTask[] => {
    const value = values[INPUT_OF[field]];
    if (!entered.has(field) || value === undefined) return [];
    // Compared in canonical units: the value is exact (the box's own, or a fresh entry), never a display re-read.
    return [{ date: today, values: { [field]: value }, expected: { [field]: seen.today[field] }, unit: 'si' }];
  });
  const answers = await saveTasksToStore(tasks, erase, correctValue);
  for (const task of tasks) {
    const field = Object.keys(task.values)[0] as DayField;
    const answer = answers.get(slotOf(today, field));
    (answer === undefined ? saved : answer === 'changed' ? changed : refused).push(field);
  }
  try {
    await flushRoadmapStore();
  } catch {
    // A cloud save that failed but reached this device's copy is the store's documented fallback.
    if (currentSaveStatus() !== 'not-saved-on-device') return { kind: 'failed' };
  }
  return { kind: 'stored', saved, changed, refused };
}

/** After a save that did not land: the rows and height the store now holds
 *  that are exactly the person's own entries. They have seen those, so a press
 *  again finds no conflict with itself. Nothing else is adopted (review A4). */
export function seenAfterFailure(seen: Seen, values: Measured, entered: Set<Field>): Seen {
  const rows = todaysRowsNow();
  const next: Seen = { heightCm: seen.heightCm, today: { ...seen.today } };
  if (entered.has('height') && getInitialInputsSync().heightCm === values.heightCm) next.heightCm = values.heightCm;
  for (const field of DAY_FIELDS) {
    const row = rows.get(field);
    if (entered.has(field) && row && row.value === values[INPUT_OF[field]]) next.today[field] = row.id;
  }
  return next;
}

/** A next-step link's address: a path on this store only, "/" but not "//" (US-74 AC6, review U3). */
export function safeHref(raw: string | undefined): string | null {
  const href = raw?.trim();
  return href && href.startsWith('/') && !href.startsWith('//') && !href.startsWith('/\\') ? href : null;
}
