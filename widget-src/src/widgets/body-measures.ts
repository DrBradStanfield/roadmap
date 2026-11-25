// The single-topic widgets' height, weight and waist (US-74): what the record
// holds, the save and the results. Every rule here is the full app's own: the
// store's profile save, the one routing rule for a day's value
// (lib/matrix-save.ts via saveTasksToStore), its flush, and health-core's plan
// and tiles. This file only joins them for three boxes; boxes.ts reads them.
import { calculateHealthResults } from '@roadmap/health-core/calculations';
import { dayOf, localDay } from '@roadmap/health-core/merge';
import { planInputsFrom } from '@roadmap/health-core/plan';
import { healthyWaistBelow } from '@roadmap/health-core/row-target';
import { statTiles, type StatTile } from '@roadmap/health-core/stat-tiles';
import type { HealthInputs } from '@roadmap/health-core/types';
import { detectUnitSystem, getDisplayLabel, type UnitSystem } from '@roadmap/health-core/units';
import { validateHealthInputs } from '@roadmap/health-core/validation';
import { saveTasksToStore } from '../hooks/useLongitudinalSave';
import { activeRowIndex, slotOf, type SaveTask } from '../lib/matrix-save';
import {
  correctValue, countMeasuresAdded, currentSaveStatus, flushRoadmapStore, getBackendKind, getInitialInputsSync,
  loadAllHistorySync, loadLatestMeasurementsSync, saveChangedMeasurements,
} from '../lib/roadmap-data';
import { healthWritesAllowed, loadUnitPreference } from '../lib/storage';
import { INPUT_OF, type Field, type Measured } from './boxes';

/** The two day-slotted values the widget saves. */
const DAY_FIELDS = ['weight', 'waist'] as const;
type DayField = (typeof DAY_FIELDS)[number];

/** A day value as the person has seen it: the row the box showed for its
 *  `day` (null for none), kept together with that day (review R5). */
export interface SeenRow { id: string | null; day: string }

/** What the person has seen of the record: the height the box showed, and
 *  per day value the row it showed and its day. A save may replace only these;
 *  it never adopts a row or height the person has not seen (review A4). A row
 *  seen on another day says nothing of today's: past midnight a field expects
 *  none (X3, R5). */
export interface Seen {
  heightCm?: number; rows: Record<DayField, SeenRow>;
  /** Entries a failed save staged in the store: kept, and counted, by the next save that lands (review A3, C8). */
  pending?: Staged;
}
/** What a save wrote into the store before it learned whether the store kept it. */
export interface Staged { saved: Field[]; inserted: string[] }

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

/** The day of the record's latest weight and waist, for the line beside a box filled from it (review X2). */
export function recordDays(): Partial<Record<DayField, string>> {
  const latest = loadLatestMeasurementsSync()?.previousMeasurements ?? [];
  const out: Partial<Record<DayField, string>> = {};
  for (const field of DAY_FIELDS) {
    const row = latest.find((m) => m.metricType === field);
    if (row) out[field] = dayOf(row.recordedAt);
  }
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
  return seenWith({ rows: { weight: { id: null, day: '' }, waist: { id: null, day: '' } } }, new Set<Field>(['height', 'weight', 'waist']));
}

/** `seen` with `fields` seen anew from the record as it is now; the others as they were (review R5). */
export function seenWith(seen: Seen, fields: ReadonlySet<Field>): Seen {
  const rows = todaysRowsNow(), day = localDay(new Date());
  const next: Seen = { ...seen, rows: { ...seen.rows } };
  if (fields.has('height')) next.heightCm = getInitialInputsSync().heightCm;
  for (const field of DAY_FIELDS) if (fields.has(field)) next.rows[field] = { id: rows.get(field)?.id ?? null, day };
  return next;
}

/** What the plan reads from the record (US-74 AC3): its tiles for the
 *  waist-to-height ratio and BMI, and the waist target line. */
export interface Results {
  /** The plan's waist-to-height tile; absent with no waist on record. */
  whtr?: StatTile;
  /** The plan's BMI tile, its status the composite assessment's; absent with no weight on record. */
  bmi?: StatTile;
  /** The full app's waist target, "<89 cm" (its grid prints "Target: <89 cm", rowTarget), which needs only the height. */
  target: string;
}

/** The plan's results for these values over the record's profile (sex, birth
 *  date), by the full app's own steps: validate, strip what the plan strips
 *  (planInputsFrom, as HealthTool and computePlan do), then its calculation and
 *  tiles (review C3). Null when the plan has no usable height. */
export function resultsFor(values: Measured, system: UnitSystem): Results | null {
  const { sex, birthYear, birthMonth } = getInitialInputsSync();
  const inputs: Partial<HealthInputs> = { sex, birthYear, birthMonth, ...values };
  const planInputs = planInputsFrom(inputs, validateHealthInputs(inputs));
  if (!planInputs) return null;
  const tiles = statTiles(calculateHealthResults(planInputs, system), { unitSystem: system, sex: planInputs.sex });
  // rowTarget's waist line, without its "Target:" word: the widget labels it itself.
  const target = `<${healthyWaistBelow(planInputs.heightCm, system)} ${getDisplayLabel('waist', system)}`;
  return { whtr: tiles.find((t) => t.key === 'whtr'), bmi: tiles.find((t) => t.key === 'bmi'), target };
}

/**
 * How a save ended. `stored`: the store kept the record (or its device copy,
 * its documented fallback), or nothing needed writing. `saved`: the entries
 * written, a real insert or correction (review C5); an entry equal to what the
 * record holds writes nothing and is in no list. `changed`: entries not
 * written because the record moved under the person (another tab or device).
 * `refused`: entries the store would not take. `failed`: the store could not
 * keep the record.
 */
export type SaveOutcome =
  | { kind: 'stored'; saved: Field[]; changed: Field[]; refused: Field[] }
  | { kind: 'failed'; staged: Staged };

/**
 * Save what the person entered (US-74 AC4), never a value only filled from
 * the record (review A1): a height to the profile by the store's profile save,
 * a weight and a waist as today's values through the full app's own save.
 * Each replaces only what the person saw (`seen`, review A4). Then wait for
 * the store to keep it (review A3). `values` hold no errors (readBoxes).
 * `erase`: the erase the page showed when the save was asked; a record at another one takes nothing (US-75 AC8).
 */
export async function saveMeasured(values: Measured, entered: Set<Field>, seen: Seen, system: UnitSystem, erase: string): Promise<SaveOutcome> {
  const none: Staged = { saved: [], inserted: [] };
  if (getBackendKind() === 'local' && !healthWritesAllowed()) return { kind: 'failed', staged: none };
  const saved: Field[] = [], changed: Field[] = [], refused: Field[] = [];
  if (entered.has('height') && values.heightCm !== undefined) {
    const recorded = getInitialInputsSync().heightCm;
    if (recorded !== seen.heightCm) changed.push('height');
    else if (values.heightCm !== recorded) {
      const profile = await saveChangedMeasurements({ heightCm: values.heightCm }, { heightCm: recorded }, erase);
      if (!profile.ok) return { kind: 'failed', staged: none };
      (profile.refused ? refused : saved).push('height');
    }
  }
  const today = localDay(new Date());
  // The rows seen were another day's: of today's, the person has seen none (review X3).
  const expected = (field: DayField) => (seen.rows[field].day === today ? seen.rows[field].id : null);
  const tasks: SaveTask[] = DAY_FIELDS.flatMap((field): SaveTask[] => {
    const value = values[INPUT_OF[field]];
    if (!entered.has(field) || value === undefined) return [];
    // In the unit it was typed in, so "the same as saved" is judged as the full app judges a typed cell (review C5).
    return [{ date: today, values: { [field]: value }, expected: { [field]: expected(field) }, unit: system }];
  });
  const before = todaysRowsNow();
  // Not counted as added here: only once the store has kept the row (review C8).
  const answers = await saveTasksToStore(tasks, erase, correctValue, false);
  const after = todaysRowsNow();
  const inserted: string[] = [];
  for (const task of tasks) {
    const field = Object.keys(task.values)[0] as DayField;
    const answer = answers.get(slotOf(today, field));
    if (answer === 'changed') changed.push(field);
    else if (answer !== undefined) refused.push(field);
    else if (after.get(field)?.id !== before.get(field)?.id) {
      saved.push(field); // a real insert or correction, not a value the same as the row's (review C5)
      if (!before.get(field)) inserted.push(after.get(field)!.id);
    }
  }
  try {
    await flushRoadmapStore();
  } catch {
    // A cloud save that failed but reached this device's copy is the store's documented fallback.
    if (currentSaveStatus() !== 'not-saved-on-device') return { kind: 'failed', staged: { saved, inserted } };
  }
  // A failed save's entries, staged then, are kept now: they count as this save's (review A3, C8).
  for (const field of seen.pending?.saved ?? []) if (!saved.includes(field) && !changed.includes(field) && !refused.includes(field)) saved.push(field);
  inserted.push(...(seen.pending?.inserted ?? []));
  // The full app's own counter for a prompted measure added, now that the row is kept (review C8).
  countMeasuresAdded(loadAllHistorySync().filter((row) => inserted.includes(row.id)));
  return { kind: 'stored', saved, changed, refused };
}

/** After a save that did not land: the rows and height the store now holds
 *  that are exactly the person's own entries. They have seen those, so a press
 *  again finds no conflict with itself. Nothing else is adopted (review A4). */
export function seenAfterFailure(seen: Seen, values: Measured, entered: Set<Field>, staged: Staged): Seen {
  const rows = todaysRowsNow(), day = localDay(new Date());
  const next: Seen = { ...seen, rows: { ...seen.rows } };
  if (entered.has('height') && getInitialInputsSync().heightCm === values.heightCm) next.heightCm = values.heightCm;
  for (const field of DAY_FIELDS) {
    const row = rows.get(field);
    if (entered.has(field) && row && row.value === values[INPUT_OF[field]]) next.rows[field] = { id: row.id, day };
  }
  next.pending = {
    saved: [...new Set([...(seen.pending?.saved ?? []), ...staged.saved])],
    inserted: [...new Set([...(seen.pending?.inserted ?? []), ...staged.inserted])],
  };
  return next;
}

/** A next-step link's address: a path on this store only (US-74 AC6, review
 *  U3, X6). No whitespace or control character anywhere (a browser drops tabs
 *  and newlines before it resolves, so "/\t/evil.com" would leave the store);
 *  resolved against this page's origin, which it must keep; the resolved path
 *  is what renders, and it is checked again as rendered ("/.//evil.com"
 *  normalises to "//evil.com", review R3). */
export function safeHref(raw: string | undefined, origin = window.location.origin): string | null {
  // The raw setting, untrimmed: whitespace anywhere, even at the ends, refuses it (review R3).
  // eslint-disable-next-line no-control-regex
  const local = (path: string) => path.startsWith('/') && !path.startsWith('//') && !path.startsWith('/\\') && !/[\s\u0000-\u001f\u007f]/.test(path);
  if (!raw || !local(raw)) return null;
  try {
    const url = new URL(raw, origin);
    const path = url.pathname + url.search + url.hash;
    // The exact string the anchor gets is checked again: a path that normalises to "//host" would leave the store.
    return url.origin === origin && local(path) && new URL(path, origin).origin === origin ? path : null;
  } catch {
    return null;
  }
}
