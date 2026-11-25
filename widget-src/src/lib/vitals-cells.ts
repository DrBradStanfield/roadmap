// What is typed into the vitals matrix (StartingInfoVitals), as a commit
// saves it: the keys a cell is typed under, and the blood-pressure pair that
// saves together or not at all.

import { type UnitSystem, toCanonicalValue } from '@roadmap/health-core/units';
import { parseLocalisedNumber } from '@roadmap/health-core/parseNumber';
import { readTypedValue, validateTypedValue } from './blood-test-cell';

// ── Blood-pressure helpers (atomic sys+dia pair) ─────────────────────────
// BP is a two-field value: a save must commit systolic AND diastolic together
// or neither. These ranges gate the commit, so a half-entered pair never lands.
const BP_SYS_MIN = 60, BP_SYS_MAX = 250;
const BP_DIA_MIN = 40, BP_DIA_MAX = 150;

/** True only when both fields hold a valid, in-physiological-range number,
 *  the right way up (US-02 AC8) — the gate that stops a commit from saving a
 *  half-entered or swapped BP pair. */
export function bpPairReady(sys: string, dia: string): boolean {
  const s = parseLocalisedNumber(sys);
  const d = parseLocalisedNumber(dia);
  return (
    s != null && s >= BP_SYS_MIN && s <= BP_SYS_MAX &&
    d != null && d >= BP_DIA_MIN && d <= BP_DIA_MAX && s > d
  );
}

/** What is typed in a vitals cell: a weight, a waist, or one half of a
 *  blood pressure (sys and dia share one cell). */
export type VitalsKey = 'weight' | 'waist' | 'sys' | 'dia';
/** The field each one is: a weight's or waist's unit is kept under it. */
export const FIELD_OF = { weight: 'weightKg', waist: 'waistCm', sys: 'systolicBp', dia: 'diastolicBp' } as const;

/** One column's typed vitals (the draft's, or a saved column's empty cells)
 *  as the cells a commit saves: a weight, a waist, a BP pair committed
 *  together (mmHg is stored as typed). `values` (SI, by metric) is null for a
 *  cell that cannot be saved as it stands: out of range, not a number, or
 *  half a pair. */
export function vitalsCellsOf(
  typed: Partial<Record<VitalsKey, string>>,
  unitFor: (metric: 'weight' | 'waist') => UnitSystem,
): Array<{ keys: VitalsKey[]; values: Record<string, number> | null }> {
  const cells: Array<{ keys: VitalsKey[]; values: Record<string, number> | null }> = [];
  for (const metric of ['weight', 'waist'] as const) {
    const text = typed[metric];
    if (!text) continue;
    const unit = unitFor(metric);
    const ok = !validateTypedValue(metric, text, unit).error;
    cells.push({ keys: [metric], values: ok ? { [metric]: toCanonicalValue(metric, readTypedValue(metric, text, unit)!, unit) } : null });
  }
  const { sys = '', dia = '' } = typed;
  if (sys || dia) {
    const ok = bpPairReady(sys, dia);
    cells.push({ keys: ['sys', 'dia'], values: ok ? { systolic_bp: parseLocalisedNumber(sys)!, diastolic_bp: parseLocalisedNumber(dia)! } : null });
  }
  return cells;
}
