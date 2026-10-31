// The one source of the target a value is read against, as the web's grids
// print it under each unit and the phone's My data rows print it under each
// name (US-62 AC9). Four sources: the blood tests' reference hints, Lp(a)'s in
// its chosen unit, the plan's vitals targets, and a catalogue test's printed
// range. The iPhone is to call it too.

import { type CellUnit, isLpaUnit } from './cell-unit';
import { lpaLine, lpaRefHint, refHintVariant } from './reference-hints';
import {
  type MetricType,
  type UnitSystem,
  bpTargetFor,
  elevatedWaistFromCm,
  formatDisplayValue,
  formatTargetLine,
  getDisplayLabel,
  isWaistToHeightElevated,
  waistToHeightRatio,
} from './units';

/** Whom a value is graded for against adult thresholds: their sex (some lines
 *  differ by it), or null to grade nothing, as for a known minor (US-07 AC6). */
export type Grading = { sex?: 'male' | 'female' } | null;

/** What the plan was computed from: its age sets the blood-pressure target,
 *  its ideal body weight (kg) the weight target and its height (cm) the
 *  waist target. Null until there is a plan. */
export type RowTargetPlan = { age?: number; idealBodyWeight?: number; heightCm?: number };

/** A core metric, blood pressure (one reading, two halves), or a catalogue
 *  test's printed range, in the unit it was printed in. */
export type RowSubject = MetricType | 'blood_pressure' | { referenceLow?: number | null; referenceHigh?: number | null };

/** `full`: the grid's line, unit and all. `bare`: the row's target, with no
 *  unit (the row prints the unit under the value); null when there is
 *  nothing to print yet, so the row shows its date alone. */
export type RowTarget = { full: string; bare: string | null };

/** What the vitals grid says in place of a plan target, in the form's order
 *  (US-62 AC13): the plan needs a height, and the weight target needs sex. */
export const TARGET_NEEDS_HEIGHT = 'Set height to see target';
export const TARGET_NEEDS_SEX = 'Set sex to see target';
const needsHeight: RowTarget = { full: TARGET_NEEDS_HEIGHT, bare: null };
const needsSex: RowTarget = { full: TARGET_NEEDS_SEX, bare: null };

/** The waist target's number, in the display unit: the first waist, at the
 *  unit's display step, that the plan grades elevated at this height. A waist
 *  shown below "<X" reads healthy, and X itself elevated (US-06 AC5). */
export function healthyWaistBelow(heightCm: number, unit: UnitSystem): string {
  const elevated = (cm: number) => isWaistToHeightElevated(waistToHeightRatio(cm, heightCm));
  return formatTargetLine('waist', elevatedWaistFromCm(heightCm), unit, elevated);
}

/**
 * The target `metric` is read against, in `unit`, for `grading`, from `plan`.
 * Null: no target to print (PSA, eGFR, a catalogue test printed without a
 * range). A known minor (`grading` null) loses the adult targets, every
 * blood-test hint and the weight and blood-pressure targets; the waist target
 * stays, since waist-to-height applies to children too, and so does a range
 * the lab printed (US-07 AC6).
 */
export function rowTarget(metric: RowSubject, unit: CellUnit, grading: Grading, plan: RowTargetPlan | null): RowTarget | null {
  if (typeof metric === 'object') return printedRange(metric.referenceLow ?? null, metric.referenceHigh ?? null);
  if (metric === 'waist') {
    if (plan?.heightCm == null) return needsHeight;
    const line = `<${healthyWaistBelow(plan.heightCm, unit as UnitSystem)}`;
    return { full: `Target: ${line} ${getDisplayLabel('waist', unit as UnitSystem)}`, bare: `Target ${line}` };
  }
  if (!grading) return null;
  if (metric === 'blood_pressure') {
    if (!plan) return needsHeight;
    const line = `<${bpTargetFor(plan.age)}/80`;
    return { full: `Target: ${line} mmHg`, bare: `Target ${line}` };
  }
  if (metric === 'weight') {
    if (!plan) return needsHeight;
    if (plan.idealBodyWeight == null) return needsSex;
    const line = formatDisplayValue('weight', plan.idealBodyWeight, unit as UnitSystem);
    return { full: `Target: ${line} ${getDisplayLabel('weight', unit as UnitSystem)}`, bare: `Target ${line}` };
  }
  if (isLpaUnit(unit)) return { full: lpaRefHint(unit), bare: `Normal ${lpaLine(unit)}` };
  const hint = refHintVariant(metric, grading.sex);
  if (!hint) return null;
  const system = unit === 'si' ? 'si' : 'conv';
  return { full: hint[system], bare: hint.bare[system] };
}

/** A lab's printed range: "Ref: 135–145" in the grid, as the upload review
 *  prints it, and "Ref 135–145", "Ref <5" or "Ref >40" in a row, as labs
 *  mostly print a one-sided range (a printed "<5" is stored as referenceHigh 5). */
function printedRange(low: number | null, high: number | null): RowTarget | null {
  if (low == null && high == null) return null;
  const bare = low != null && high != null ? `${low}–${high}` : high != null ? `<${high}` : `>${low}`;
  return { full: `Ref: ${low ?? '–'}–${high ?? '–'}`, bare: `Ref ${bare}` };
}
