// Single source of truth for blood-test reference-range hint strings shown
// under each metric's unit chip in the matrix UI and (derived) under the
// legacy form labels. SI ↔ conventional pairs, with optional male/female
// variants for sex-specific reference ranges (creatinine, HDL).

import type { MetricType } from './units';

export type RefHint = { si: string; conv: string };
export type SexedRefHint = RefHint & { male?: RefHint; female?: RefHint };

export const REFERENCE_HINTS: Partial<Record<MetricType, SexedRefHint>> = {
  hba1c:             { si: 'Normal: <39 mmol/mol',     conv: 'Normal: <5.7%' },
  creatinine:        {
    si: 'Normal: 45–110 µmol/L', conv: 'Normal: 0.5–1.2 mg/dL',
    male:   { si: 'Normal: 60–110 µmol/L', conv: 'Normal: 0.7–1.2 mg/dL' },
    female: { si: 'Normal: 45–90 µmol/L',  conv: 'Normal: 0.5–1.0 mg/dL' },
  },
  apob:              { si: 'Optimal: <0.5 g/L',        conv: 'Optimal: <50 mg/dL' },
  ldl:               { si: 'Optimal: <1.4 mmol/L',     conv: 'Optimal: <55 mg/dL' },
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
