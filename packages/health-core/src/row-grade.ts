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
  elevatedWaistFromCm,
  isWaistToHeightElevated,
  rangeFault,
  waistToHeightRatio,
} from './units';
import { getLipidStatus } from './calculations';
import { METRIC_TO_FIELD } from './mappings';
import { certainValue, isLimitField, limitLabelValue, limitRepresentative, linesReached, type Comparator } from './lab-limits';

export type GradeStatus = 'ok' | 'warn' | 'bad' | null;

/** Clinical threshold mapping. Returns null for metrics whose status is
 *  judged elsewhere (e.g. creatinine → eGFR), and for a value the plan leaves
 *  out as out of range, such as a stored LDL 0 (US-03 AC7). */
export function statusOf(metric: MetricType, siValue: number, grading: Grading): GradeStatus {
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

/** Weight's and waist's lines, which their grades below read and a limit is judged against
 *  (US-12 AC21): weight's around the ideal (5 under, 2 over, 5 over), waist's at the healthy
 *  ratio and 8 cm past half the height. */
const weightLines = (ibw: number) => [ibw - 5, ibw + 2, ibw + 5] as const;
const waistLines = (heightCm: number) => [elevatedWaistFromCm(heightCm), heightCm * 0.5 + 8] as const;

function weightStatus(siKg: number | null | undefined, ibw?: number): GradeStatus {
  if (siKg == null || Number.isNaN(siKg) || ibw == null) return null;
  const [low, okTop, warnTop] = weightLines(ibw);
  if (siKg >= low && siKg <= okTop) return 'ok';
  if (siKg <= warnTop) return 'warn';
  return 'bad';
}
/** 'ok' exactly when the plan counts the waist as healthy (US-06 AC5). */
function waistStatus(siCm: number | null | undefined, heightCm?: number): GradeStatus {
  if (siCm == null || Number.isNaN(siCm) || heightCm == null) return null;
  if (!isWaistToHeightElevated(waistToHeightRatio(siCm, heightCm))) return 'ok';
  if (siCm <= waistLines(heightCm)[1]) return 'warn';
  return 'bad';
}
/** A blood pressure half's lines: the systolic target and 10 above it, diastolic 80 and 85. A half's
 *  grade is how many it has reached (ok, warn, bad), and the pair's the worse half's. */
const bpLines = (sysTarget: number) => ({ sys: [sysTarget, sysTarget + 10], dia: [80, 85] });
const BP_GRADES = ['ok', 'warn', 'bad'] as const;

/** Neutral with no systolic target: there is no plan (US-06 AC5). */
export function bpStatus(sys: number | null | undefined, dia: number | null | undefined, sysTarget: number | undefined): GradeStatus {
  if (sys == null || dia == null || Number.isNaN(sys) || Number.isNaN(dia) || sysTarget === undefined) return null;
  const lines = bpLines(sysTarget);
  return BP_GRADES[Math.max(linesReached(lines.sys, undefined, sys)[0], linesReached(lines.dia, undefined, dia)[0])];
}

/** Whom and against what plan a row's value is graded. */
export interface GradeContext {
  grading: Grading;
  plan: RowTargetPlan | null;
}

/** A saved core limit's input field, when the plan can read one (US-12 AC20). */
function limitField(metric: MetricType) {
  const field = METRIC_TO_FIELD[metric];
  return field && isLimitField(field) ? field : null;
}

/** A blood pressure as graded: each half, with its limit if it was printed as one. */
export type PressureReading = { value: number; comparator?: Comparator; dia?: { value: number; comparator?: Comparator } };

/**
 * Whether a value printed as a limit says `LIMIT_NOT_GRADED`, given the grade it got: only when
 * there is something to grade it against (an exact value there would be graded) and the rule
 * leaves it without a grade (US-12 AC20, AC21). Weight needs an adult and an ideal weight, waist
 * a height, blood pressure an adult's plan; a blood test an adult, and says it when the plan
 * cannot grade the limit. A known minor, or no plan, says nothing, as an exact value there does.
 */
export function limitUngraded(metric: MetricType | 'blood_pressure', status: GradeStatus, { grading, plan }: GradeContext, reading: PressureReading): boolean {
  const comparator = reading.comparator;
  if (!comparator && !reading.dia?.comparator) return false;
  switch (metric) {
    case 'weight': return status === null && !!grading && plan?.idealBodyWeight != null;
    case 'waist': return status === null && plan?.heightCm != null;
    case 'blood_pressure': return status === null && !!grading && !!plan;
    default: {
      if (!grading || !comparator) return false;
      const field = limitField(metric);
      return !field || limitRepresentative(field, comparator, reading.value) === null;
    }
  }
}

/** A saved core value's colour. A limit is coloured only when its bound
 *  decides against the plan's lines and the grid's own colour bands, and
 *  never by the bound itself (US-12 AC20). */
export function savedStatus(metric: MetricType, si: number, comparator: Comparator | undefined, grading: Grading): GradeStatus {
  if (!comparator) return statusOf(metric, si, grading);
  const field = limitField(metric);
  const graded = field ? limitLabelValue(field, comparator, si) : null;
  return graded === null ? null : statusOf(metric, graded, grading);
}

/** A value's grade, as the grids colour it: the blood tests by their lines,
 *  a limit only when its bound decides (US-12 AC20), weight and waist by the
 *  plan, a limit only when certain (US-12 AC21); none for a known minor's adult lines. */
export function valueStatus(metric: MetricType, si: number, { grading, plan }: GradeContext, comparator?: Comparator): GradeStatus {
  if (metric === 'weight') {
    const ibw = grading ? plan?.idealBodyWeight : undefined;
    const value = ibw == null ? null : certainValue(weightLines(ibw), comparator, si);
    return value === null ? null : weightStatus(value, ibw);
  }
  if (metric === 'waist') {
    const heightCm = plan?.heightCm;
    const value = heightCm == null ? null : certainValue(waistLines(heightCm), comparator, si);
    return value === null ? null : waistStatus(value, heightCm);
  }
  return savedStatus(metric, si, comparator, grading);
}

/** A pressure's grade against the plan's systolic target; none without a plan or for a known minor.
 *  With a half printed as a limit, graded only when the grade is the same for every pair both
 *  bounds allow (US-12 AC21): the pair's grade is the worse half's, so the fewest and the most
 *  lines each half can have reached decide it, exactly. ">160/<90" is certainly high, "<125/78"
 *  and "<120.00001/70" open, "<120/70" on target. */
export function pressureStatus(r: PressureReading, { grading, plan }: GradeContext): GradeStatus {
  const sysTarget = plan && grading ? bpTargetFor(plan.age) : undefined;
  // No target, a missing half or not a number: no grade, as bpStatus says.
  if (!r.dia || bpStatus(r.value, r.dia.value, sysTarget) === null) return null;
  const lines = bpLines(sysTarget!);
  const [sysFewest, sysMost] = linesReached(lines.sys, r.comparator, r.value);
  const [diaFewest, diaMost] = linesReached(lines.dia, r.dia.comparator, r.dia.value);
  const fewest = Math.max(sysFewest, diaFewest);
  return fewest === Math.max(sysMost, diaMost) ? BP_GRADES[fewest] : null;
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
export function gradeWords(status: GradeStatus, metric: string): string | null {
  if (!status || status === 'ok') return null;
  if (metric === 'hdl') return status === 'bad' ? 'low' : 'below optimal';
  if (metric === 'weight') return status === 'bad' ? 'above target' : 'outside target';
  return status === 'bad' ? 'high' : `above ${LINE_WORD[metric] ?? 'target'}`;
}
