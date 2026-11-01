// The one source of a value's grade, as the web's grids and phone rows colour
// it and the iPhone's My data rows colour it too (US-62 AC8, US-25 AC17):
// ok, amber (warn) or red (bad), and the words a screen reader says off
// target. Moved here unchanged from the widget (blood-test-cell.ts statusOf,
// StartingInfoVitals.tsx's vitals grades, MyDataRows.tsx gradeWords) so both
// apps grade by one rule. Pure: data in, data out.

import { cellRange } from './cell-unit';
import type { Grading, RowTargetPlan } from './row-target';
import {
  APOB_THRESHOLDS,
  CREATININE_GRID_BANDS,
  HBA1C_THRESHOLDS,
  HDL_GRID_BANDS,
  LDL_THRESHOLDS,
  LPA_THRESHOLDS,
  PSA_THRESHOLDS,
  TOTAL_CHOLESTEROL_THRESHOLDS,
  TRIGLYCERIDES_THRESHOLDS,
  type MetricType,
  bpTargetFor,
  isWaistToHeightElevated,
  rangeFault,
  waistToHeightRatio,
} from './units';
import { getLipidStatus } from './calculations';

export type Status = 'ok' | 'warn' | 'bad' | null;

/** Clinical threshold mapping. Returns null for metrics whose status is
 *  judged elsewhere (e.g. creatinine → eGFR), and for a value the plan leaves
 *  out as out of range, such as a stored LDL 0 (US-03 AC7). */
export function statusOf(metric: MetricType, siValue: number, grading: Grading): Status {
  if (!grading || siValue == null || Number.isNaN(siValue) || rangeFault(cellRange(metric, 'si'), siValue)) return null;
  const { sex } = grading;
  switch (metric) {
    case 'hba1c':
      if (siValue >= HBA1C_THRESHOLDS.diabetes) return 'bad';
      if (siValue >= HBA1C_THRESHOLDS.prediabetes) return 'warn';
      return 'ok';
    case 'ldl': {
      // The LDL tile's grade: amber from the plan's target, as ApoB is from its 0.5 (US-07 AC5)
      const s = getLipidStatus(siValue, LDL_THRESHOLDS);
      return s === 'Optimal' ? 'ok' : s === 'High' || s === 'Very High' ? 'bad' : 'warn';
    }
    case 'total_cholesterol':
      if (siValue >= TOTAL_CHOLESTEROL_THRESHOLDS.high) return 'bad';
      if (siValue >= TOTAL_CHOLESTEROL_THRESHOLDS.borderline) return 'warn';
      return 'ok';
    case 'hdl': {
      // Higher is better. No sex, no grade: never assume one (US-62 AC13).
      if (!sex) return null;
      const { okFrom, badBelow } = HDL_GRID_BANDS[sex];
      if (siValue >= okFrom) return 'ok';
      if (siValue >= badBelow) return 'warn';
      return 'bad';
    }
    case 'triglycerides':
      if (siValue >= TRIGLYCERIDES_THRESHOLDS.high) return 'bad';
      if (siValue >= TRIGLYCERIDES_THRESHOLDS.borderline) return 'warn';
      return 'ok';
    case 'apob':
      if (siValue >= APOB_THRESHOLDS.high) return 'bad';
      if (siValue >= APOB_THRESHOLDS.borderline) return 'warn';
      return 'ok';
    case 'lpa':
      if (siValue >= LPA_THRESHOLDS.elevated) return 'bad';
      if (siValue >= LPA_THRESHOLDS.normal) return 'warn';
      return 'ok';
    case 'psa':
      return siValue >= PSA_THRESHOLDS.normal ? 'warn' : 'ok';
    case 'creatinine': {
      if (!sex) return null; // the ceiling differs by sex; never assume one (US-62 AC13)
      const { okMax, badFrom } = CREATININE_GRID_BANDS[sex];
      if (siValue >= badFrom) return 'bad';
      if (siValue > okMax) return 'warn';
      return 'ok';
    }
    default:
      return null;
  }
}

// ── Vitals: their lines depend on the plan (IBW for weight, WHtR < 0.5 for waist, BP target) ──

function weightStatus(siKg: number | null | undefined, ibw?: number): Status {
  if (siKg == null || Number.isNaN(siKg) || ibw == null) return null;
  if (siKg >= ibw - 5 && siKg <= ibw + 2) return 'ok';
  if (siKg <= ibw + 5) return 'warn';
  return 'bad';
}
/** 'ok' exactly when the plan counts the waist as healthy (US-06 AC5). */
function waistStatus(siCm: number | null | undefined, heightCm?: number): Status {
  if (siCm == null || Number.isNaN(siCm) || heightCm == null) return null;
  if (!isWaistToHeightElevated(waistToHeightRatio(siCm, heightCm))) return 'ok';
  if (siCm <= heightCm * 0.5 + 8) return 'warn';
  return 'bad';
}
/** Neutral with no systolic target: there is no plan (US-06 AC5). */
export function bpStatus(sys: number | null | undefined, dia: number | null | undefined, sysTarget: number | undefined): Status {
  if (sys == null || dia == null || Number.isNaN(sys) || Number.isNaN(dia) || sysTarget === undefined) return null;
  const diaTarget = 80;
  if (sys < sysTarget && dia < diaTarget) return 'ok';
  if (sys < sysTarget + 10 && dia < diaTarget + 5) return 'warn';
  return 'bad';
}
export function simpleStatus(metric: 'weight' | 'waist', si: number | null | undefined, ibwKg?: number, planHeightCm?: number): Status {
  return metric === 'weight' ? weightStatus(si, ibwKg) : waistStatus(si, planHeightCm);
}

/** Whom and against what plan a row's value is graded. */
export interface GradeContext {
  grading: Grading;
  plan: RowTargetPlan | null;
}

/** A value's grade, as the grids colour it: the blood tests by their lines,
 *  weight and waist by the plan; none for a known minor's adult lines. */
export function valueStatus(metric: MetricType, si: number, { grading, plan }: GradeContext): Status {
  if (metric === 'weight') return simpleStatus('weight', si, grading ? plan?.idealBodyWeight : undefined);
  if (metric === 'waist') return simpleStatus('waist', si, undefined, plan?.heightCm);
  return statusOf(metric, si, grading);
}

/** A pressure's grade against the plan's systolic target; none without a plan or for a known minor. */
export function pressureStatus(r: { value: number; dia?: { value: number } }, { grading, plan }: GradeContext): Status {
  return bpStatus(r.value, r.dia?.value, plan && grading ? bpTargetFor(plan.age) : undefined);
}

/** The line each metric's grade is read against, in the words its target prints. */
const LINE_WORD: Record<string, string> = {
  ldl: 'optimal', apob: 'optimal', total_cholesterol: 'optimal',
  hba1c: 'normal', triglycerides: 'normal', lpa: 'normal', creatinine: 'normal',
  waist: 'target', blood_pressure: 'target',
};

/** A grade as a screen reader hears it beside the value ("3.4, above optimal,
 *  previous 2.9"): the colour says it on screen. Said only off target, so no
 *  word can contradict the printed target. Weight's amber covers both sides
 *  of its target, and HDL is better higher. */
export function gradeWords(status: Status, metric: string): string | null {
  if (!status || status === 'ok') return null;
  if (metric === 'hdl') return status === 'bad' ? 'low' : 'below optimal';
  if (metric === 'weight') return status === 'bad' ? 'above target' : 'outside target';
  return status === 'bad' ? 'high' : `above ${LINE_WORD[metric] ?? 'target'}`;
}
