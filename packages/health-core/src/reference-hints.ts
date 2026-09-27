// Single source of truth for blood-test reference-range hint strings shown
// under each metric's unit chip in the matrix UI and (derived) under the
// legacy form labels. SI ↔ conventional pairs, with optional male/female
// variants for sex-specific reference ranges (creatinine, HDL).

import { type MetricType, LIPID_TREATMENT_TARGETS, formatTargetLine, getDisplayLabel } from './units';

export type RefHint = { si: string; conv: string };
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
  const at = (system: 'si' | 'conventional') => `Optimal: <${formatTargetLine(metric, target, system)} ${getDisplayLabel(metric, system)}`;
  return { si: at('si'), conv: at('conventional') };
}

export const REFERENCE_HINTS: Partial<Record<MetricType, SexedRefHint>> = {
  hba1c:             { si: 'Normal: <39 mmol/mol',     conv: 'Normal: <5.7%' },
  creatinine:        {
    si: 'Normal: 45–110 µmol/L', conv: 'Normal: 0.5–1.2 mg/dL',
    male:   { si: 'Normal: 60–110 µmol/L', conv: 'Normal: 0.7–1.2 mg/dL' },
    female: { si: 'Normal: 45–90 µmol/L',  conv: 'Normal: 0.5–1.0 mg/dL' },
  },
  apob:              optimalBelow('apob', OPTIMAL_BELOW.apob),
  ldl:               optimalBelow('ldl', OPTIMAL_BELOW.ldl),
  total_cholesterol: { si: 'Optimal: <3.5 mmol/L',     conv: 'Optimal: <135 mg/dL' },
  hdl:               {
    si: 'Optimal: >1.0/>1.3 mmol/L', conv: 'Optimal: >40/>50 mg/dL',
    male:   { si: 'Optimal: >1.0 mmol/L', conv: 'Optimal: >40 mg/dL' },
    female: { si: 'Optimal: >1.3 mmol/L', conv: 'Optimal: >50 mg/dL' },
  },
  triglycerides:     { si: 'Normal: <1.7 mmol/L',      conv: 'Normal: <150 mg/dL' },
  lpa:               { si: 'Normal: <75 nmol/L',       conv: 'Normal: <75 nmol/L' },
};

/**
 * Resolve a reference hint for a metric in the requested display unit, picking
 * a sex-specific variant when available. Returns null if no hint exists.
 */
export function refHintFor(
  metric: MetricType,
  display: 'si' | 'conventional',
  sex?: 'male' | 'female',
): string | null {
  const hint = REFERENCE_HINTS[metric];
  if (!hint) return null;
  const variant = (sex && hint[sex]) ? hint[sex]! : hint;
  return display === 'si' ? variant.si : variant.conv;
}
