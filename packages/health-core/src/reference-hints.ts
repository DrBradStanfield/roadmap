// Single source of truth for blood-test reference-range hint strings shown
// under each metric's unit chip in the matrix UI and (derived) under the
// legacy form labels. SI ↔ conventional pairs, with optional male/female
// variants for sex-specific reference ranges (creatinine, HDL).

import { type LpaUnit, type MetricType, LIPID_TREATMENT_TARGETS, LPA_THRESHOLDS, formatTargetLine, getDisplayLabel, lookupUnit } from './units';

/** `si` and `conv` are the grid's hint, unit and all; `bare` is the same
 *  target without its unit, for a row that prints the unit beside the value
 *  (`rowTarget`). Written out, not trimmed: "Normal: <5.7%" has no space
 *  before its unit. */
export type RefHint = { si: string; conv: string; bare: { si: string; conv: string } };
export type SexedRefHint = RefHint & { male?: RefHint; female?: RefHint };

/** The line each "Optimal: <X" hint prints, canonical: the plan's lipid
 *  targets. The editable matrices beside these hints show plain values; the
 *  read-only summaries grade a value against the line (US-07 AC5). */
const OPTIMAL_BELOW = { apob: LIPID_TREATMENT_TARGETS.apobGl, ldl: LIPID_TREATMENT_TARGETS.ldlMmol } as const;

/** The canonical line a metric's reference hint prints, if it prints one. */
export function refLineFor(metric: MetricType): number | undefined {
  return metric === 'apob' || metric === 'ldl' ? OPTIMAL_BELOW[metric] : undefined;
}

/** "Optimal: <X" for a lipid target, as the plan's cards state it: the first
 *  value, at the display step, that the plan grades above it (US-07 AC5). */
function optimalBelow(metric: MetricType, target: number): RefHint {
  const line = (system: 'si' | 'conventional') => `<${formatTargetLine(metric, target, system)}`;
  const at = (system: 'si' | 'conventional') => `Optimal: ${line(system)} ${getDisplayLabel(metric, system)}`;
  return { si: at('si'), conv: at('conventional'), bare: { si: `Optimal ${line('si')}`, conv: `Optimal ${line('conventional')}` } };
}

export const REFERENCE_HINTS: Partial<Record<MetricType, SexedRefHint>> = {
  hba1c:             { si: 'Normal: <39 mmol/mol',     conv: 'Normal: <5.7%',        bare: { si: 'Normal <39', conv: 'Normal <5.7' } },
  creatinine:        {
    si: 'Normal: 45–110 µmol/L', conv: 'Normal: 0.5–1.2 mg/dL', bare: { si: 'Normal 45–110', conv: 'Normal 0.5–1.2' },
    male:   { si: 'Normal: 60–110 µmol/L', conv: 'Normal: 0.7–1.2 mg/dL', bare: { si: 'Normal 60–110', conv: 'Normal 0.7–1.2' } },
    female: { si: 'Normal: 45–90 µmol/L',  conv: 'Normal: 0.5–1.0 mg/dL', bare: { si: 'Normal 45–90', conv: 'Normal 0.5–1.0' } },
  },
  apob:              optimalBelow('apob', OPTIMAL_BELOW.apob),
  ldl:               optimalBelow('ldl', OPTIMAL_BELOW.ldl),
  total_cholesterol: { si: 'Optimal: <3.5 mmol/L',     conv: 'Optimal: <135 mg/dL',  bare: { si: 'Optimal <3.5', conv: 'Optimal <135' } },
  hdl:               {
    si: 'Optimal: >1.0/>1.3 mmol/L', conv: 'Optimal: >40/>50 mg/dL', bare: { si: 'Optimal >1.0/>1.3', conv: 'Optimal >40/>50' },
    male:   { si: 'Optimal: >1.0 mmol/L', conv: 'Optimal: >40 mg/dL', bare: { si: 'Optimal >1.0', conv: 'Optimal >40' } },
    female: { si: 'Optimal: >1.3 mmol/L', conv: 'Optimal: >50 mg/dL', bare: { si: 'Optimal >1.3', conv: 'Optimal >50' } },
  },
  triglycerides:     { si: 'Normal: <1.7 mmol/L',      conv: 'Normal: <150 mg/dL',   bare: { si: 'Normal <1.7', conv: 'Normal <150' } },
};

/** Lp(a)'s hint in the unit its field shows (US-05 AC2): "Normal: <X", X the
 *  first value at that unit's display step the plan grades at or above 75
 *  nmol/L, by the rule of the lipid hints above. A cut-point that falls on a
 *  whole number prints whole: "<30 mg/dL", not "<30.0". */
export function lpaRefHint(unit: LpaUnit): string {
  return `Normal: ${lpaLine(unit)} ${unit}`;
}

/** Lp(a)'s "<X" alone, in `unit`: its hint without the label or unit. */
export function lpaLine(unit: LpaUnit): string {
  const { system, scale } = lookupUnit('lpa', unit)!; // every LpaUnit is in the unit table
  return `<${Number(formatTargetLine('lpa', LPA_THRESHOLDS.normal, system, undefined, scale))}`;
}

/** The metric's hint, the sex-specific variant when there is one and the sex is known. */
export function refHintVariant(metric: MetricType, sex?: 'male' | 'female'): RefHint | null {
  const hint = REFERENCE_HINTS[metric];
  if (!hint) return null;
  return (sex && hint[sex]) ? hint[sex]! : hint;
}
