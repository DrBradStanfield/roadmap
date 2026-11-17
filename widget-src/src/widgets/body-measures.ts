// The single-topic widgets' height, weight and waist (US-74): what the record
// holds, what the boxes say, the save and the results. Every rule here is the
// full app's own: health-core's validation, unit conversion, plan and tiles,
// the store's profile save, and the one routing rule for a day's value
// (lib/matrix-save.ts). This file only joins them for three boxes.
import { calculateHealthResults } from '@roadmap/health-core/calculations';
import { localDay } from '@roadmap/health-core/merge';
import { parseLocalisedNumber } from '@roadmap/health-core/parseNumber';
import { rowTarget } from '@roadmap/health-core/row-target';
import { statTiles, type StatTile } from '@roadmap/health-core/stat-tiles';
import type { HealthInputs } from '@roadmap/health-core/types';
import { cmToFeetInches, detectUnitSystem, feetInchesToCm, formatDisplayValue, toCanonicalValue, type UnitSystem } from '@roadmap/health-core/units';
import { convertValidationErrorsToUnits, getValidationErrors, validateHealthInputs } from '@roadmap/health-core/validation';
import { saveTasksToStore } from '../hooks/useLongitudinalSave';
import { activeRowIndex, slotOf, type SaveTask } from '../lib/matrix-save';
import {
  correctValue, getBackendKind, getInitialInputsSync, getShownErase,
  loadAllHistorySync, loadLatestMeasurementsSync, saveChangedMeasurements,
} from '../lib/roadmap-data';
import { healthWritesAllowed, loadUnitPreference } from '../lib/storage';

/** Height, weight and waist in canonical units (cm, kg, cm); a blank box is absent. */
export interface Measured { heightCm?: number; weightKg?: number; waistCm?: number }

/** What the boxes hold, as typed. `height` is the cm box, `feet` and `inches` the US pair. */
export interface Boxes { height: string; feet: string; inches: string; weight: string; waist: string }

/** The two day-slotted values the widget saves, by metric. */
const DAY_METRICS = [['weight', 'weightKg'], ['waist', 'waistCm']] as const;
type DayMetric = (typeof DAY_METRICS)[number][0];

/** Today's row per day metric, as the widget last read the record: the row a save expects to replace. */
export type TodaysRows = Record<DayMetric, string | null>;

/** The units the boxes start in (US-74 AC2): the record's, else the full app's own default. */
export function startingUnits(): UnitSystem {
  return getInitialInputsSync().unitSystem ?? loadUnitPreference() ?? detectUnitSystem();
}

/** The record's height, and its latest active weight and waist (US-74 AC2). */
export function recordMeasured(): Measured {
  const latest = loadLatestMeasurementsSync();
  const rowOf = (metric: DayMetric) => latest?.previousMeasurements.find((m) => m.metricType === metric)?.value;
  const out: Measured = {};
  const heightCm = getInitialInputsSync().heightCm;
  if (heightCm !== undefined) out.heightCm = heightCm;
  const weightKg = rowOf('weight'), waistCm = rowOf('waist');
  if (weightKg !== undefined) out.weightKg = weightKg;
  if (waistCm !== undefined) out.waistCm = waistCm;
  return out;
}

/** The record's rows for today, read from the store as it is now. */
export function todaysRows(): TodaysRows {
  const index = activeRowIndex(loadAllHistorySync());
  const today = localDay(new Date());
  return { weight: index.get(slotOf(today, 'weight'))?.id ?? null, waist: index.get(slotOf(today, 'waist'))?.id ?? null };
}

/** A canonical value as the full app's form shows it: converted, rounded, no trailing zeros. */
const shown = (metric: 'height' | 'weight' | 'waist', value: number | undefined, system: UnitSystem) =>
  value === undefined ? '' : String(parseFloat(formatDisplayValue(metric, value, system)));

/** The boxes for `values` in `system`; a US height reads as feet and inches, as in the full app. */
export function boxesFor(values: Measured, system: UnitSystem): Boxes {
  const pair = system === 'conventional' && values.heightCm !== undefined ? cmToFeetInches(values.heightCm) : null;
  return {
    height: system === 'si' ? shown('height', values.heightCm, system) : '',
    feet: pair ? String(pair.feet) : '',
    inches: pair ? String(pair.inches) : '',
    weight: shown('weight', values.weightKg, system),
    waist: shown('waist', values.waistCm, system),
  };
}

/** The boxes read into canonical units, whatever their range; unreadable text reads as blank. */
export function measuredFrom(boxes: Boxes, system: UnitSystem): Measured {
  const out: Measured = {};
  const num = (text: string) => parseLocalisedNumber(text.trim());
  if (system === 'si') {
    const height = num(boxes.height);
    if (height !== undefined) out.heightCm = toCanonicalValue('height', height, 'si');
  } else if (boxes.feet.trim() !== '' || boxes.inches.trim() !== '') {
    out.heightCm = feetInchesToCm(parseInt(boxes.feet, 10) || 0, parseInt(boxes.inches, 10) || 0);
  }
  const weight = num(boxes.weight), waist = num(boxes.waist);
  if (weight !== undefined) out.weightKg = toCanonicalValue('weight', weight, system);
  if (waist !== undefined) out.waistCm = toCanonicalValue('waist', waist, system);
  return out;
}

/** Field errors by the full app's validation, in the units shown (US-74 AC2): height is required,
 *  weight and waist may be blank. Keyed `heightCm`, `weightKg`, `waistCm`; empty when all is well. */
export function measuredErrors(values: Measured, system: UnitSystem): Record<string, string> {
  const validation = validateHealthInputs({ heightCm: values.heightCm, weightKg: values.weightKg, waistCm: values.waistCm });
  if (validation.success || !validation.errors) return {};
  const errors = getValidationErrors(validation.errors);
  const ours = Object.fromEntries(Object.entries(errors).filter(([field]) => field === 'heightCm' || field === 'weightKg' || field === 'waistCm'));
  return convertValidationErrorsToUnits(ours, system);
}

/** What the widget shows after a save (US-74 AC3): the plan's own tiles and the waist target line. */
export interface Results {
  /** The plan's waist-to-height tile; absent with no waist. */
  whtr?: StatTile;
  /** The plan's BMI tile, its status the composite assessment's; absent with no weight. */
  bmi?: StatTile;
  /** The full app's waist target line ("Target: <89 cm"), which needs only the height. */
  target: string;
}

/** The results the plan gives for these values, over the record's profile (sex, birth date):
 *  the same function and tiles the full app's plan runs, so the two cannot disagree. */
export function resultsFor(values: Measured & { heightCm: number }, system: UnitSystem): Results {
  const { sex, birthYear, birthMonth } = getInitialInputsSync();
  const inputs: HealthInputs = { sex, birthYear, birthMonth, ...values };
  const tiles = statTiles(calculateHealthResults(inputs, system), { unitSystem: system, sex });
  const target = rowTarget('waist', system, null, { heightCm: values.heightCm })!.full;
  return { whtr: tiles.find((t) => t.key === 'whtr'), bmi: tiles.find((t) => t.key === 'bmi'), target };
}

/** How a save ended: written (or nothing to write), or refused, with the rows for today as they are now. */
export type SaveOutcome = { saved: boolean; today: TodaysRows };

/**
 * Save what was entered (US-74 AC4): the height to the profile by the store's
 * profile save, a weight and a waist as today's values through the full app's
 * own save, `saveTasksToStore` (an empty slot is added; the row `expected` is
 * corrected; a row the widget did not see writes nothing). Never replaces the record: each write
 * goes through the store, which merges. `values` are valid (measuredErrors).
 */
export async function saveMeasured(values: Measured, system: UnitSystem, expected: TodaysRows): Promise<SaveOutcome> {
  if (getBackendKind() === 'local' && !healthWritesAllowed()) return { saved: false, today: todaysRows() };
  const erase = getShownErase();
  const recorded = getInitialInputsSync().heightCm;
  if (values.heightCm !== undefined && values.heightCm !== recorded) {
    const profile = await saveChangedMeasurements({ heightCm: values.heightCm }, { heightCm: recorded }, erase);
    if (!profile.ok || profile.refused) return { saved: false, today: todaysRows() };
  }
  const today = localDay(new Date());
  const tasks: SaveTask[] = DAY_METRICS.flatMap(([metric, field]): SaveTask[] => {
    const value = values[field];
    return value === undefined ? [] : [{ date: today, values: { [metric]: value }, expected: { [metric]: expected[metric] }, unit: system }];
  });
  const refused = await saveTasksToStore(tasks, erase, correctValue);
  return { saved: refused.size === 0, today: todaysRows() };
}

/** A next-step link's address, only a same-site path or an http(s) URL (US-74 AC6). */
export function safeHref(raw: string | undefined): string | null {
  const href = raw?.trim();
  if (!href) return null;
  if (href.startsWith('/') && !href.startsWith('//')) return href;
  try {
    const { protocol } = new URL(href);
    return protocol === 'https:' || protocol === 'http:' ? href : null;
  } catch {
    return null;
  }
}
