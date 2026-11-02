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
import { certainValue, isLimitField, limitLabelValue, limitRepresentative, type Comparator } from './lab-limits';

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

/** Each vital's lines, which its grade below reads and a limit is judged against (US-12 AC21):
 *  weight's around the ideal (5 under, 2 over, 5 over), waist's at the healthy ratio and 8 cm
 *  past half the height, blood pressure's at the target and 10/5 above it. */
const weightLines = (ibw: number) => [ibw - 5, ibw + 2, ibw + 5] as const;
const waistLines = (heightCm: number) => [elevatedWaistFromCm(heightCm), heightCm * 0.5 + 8] as const;
const DIA_TARGET = 80;
const bpLines = (sysTarget: number) => ({ sys: [sysTarget, sysTarget + 10], dia: [DIA_TARGET, DIA_TARGET + 5] });

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
/** Neutral with no systolic target: there is no plan (US-06 AC5). */
export function bpStatus(sys: number | null | undefined, dia: number | null | undefined, sysTarget: number | undefined): GradeStatus {
  if (sys == null || dia == null || Number.isNaN(sys) || Number.isNaN(dia) || sysTarget === undefined) return null;
  const { sys: [target, warnSys], dia: [diaTarget, warnDia] } = bpLines(sysTarget);
  if (sys < target && dia < diaTarget) return 'ok';
  if (sys < warnSys && dia < warnDia) return 'warn';
  return 'bad';
}

/** A grade of a value that may be printed as a limit: read at the value the limit certainly
 *  allows (`certainValue`, against the grade's own lines), or none when it leaves the grade open. */
function certainly(grade: (value: number) => GradeStatus, lines: readonly number[], value: number, comparator?: Comparator): GradeStatus {
  if (!comparator) return grade(value);
  const inside = certainValue(lines, comparator, value);
  return inside === null ? null : grade(inside);
}
export function simpleStatus(metric: 'weight' | 'waist', si: number | null | undefined, ibwKg?: number, planHeightCm?: number): GradeStatus {
  return metric === 'weight' ? weightStatus(si, ibwKg) : waistStatus(si, planHeightCm);
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

/** A limit the plan cannot grade: it shows no colour, and says `LIMIT_NOT_GRADED`. Weight and
 *  waist, with `ctx`: a limit their lines leave open (US-12 AC21). */
export function limitUngraded(metric: MetricType, bound: number, comparator?: Comparator, ctx?: GradeContext): boolean {
  if (ctx && (metric === 'weight' || metric === 'waist')) return !!comparator && valueStatus(metric, bound, ctx, comparator) === null;
  const field = limitField(metric);
  return !!comparator && (!field || limitRepresentative(field, comparator, bound) === null);
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
    return ibw == null ? null : certainly((v) => simpleStatus('weight', v, ibw), weightLines(ibw), si, comparator);
  }
  if (metric === 'waist') {
    const heightCm = plan?.heightCm;
    return heightCm == null ? null : certainly((v) => simpleStatus('waist', v, undefined, heightCm), waistLines(heightCm), si, comparator);
  }
  return savedStatus(metric, si, comparator, grading);
}

/** A blood pressure as graded: each half, with its limit if it was printed as one. */
export type PressureReading = { value: number; comparator?: Comparator; dia?: { value: number; comparator?: Comparator } };

/** A pressure's grade against the plan's systolic target; none without a plan or for a known minor.
 *  A half printed as a limit is graded only when certain: every pair both bounds allow grades the
 *  same, judged half by half against its own lines (US-12 AC21). */
export function pressureStatus(r: PressureReading, { grading, plan }: GradeContext): GradeStatus {
  const sysTarget = plan && grading ? bpTargetFor(plan.age) : undefined;
  if (sysTarget === undefined || !r.dia || (!r.comparator && !r.dia.comparator)) return bpStatus(r.value, r.dia?.value, sysTarget);
  const lines = bpLines(sysTarget);
  const sys = r.comparator ? certainValue(lines.sys, r.comparator, r.value) : r.value;
  const dia = r.dia.comparator ? certainValue(lines.dia, r.dia.comparator, r.dia.value) : r.dia.value;
  return sys === null || dia === null ? null : bpStatus(sys, dia, sysTarget);
}

/** A pressure with a half printed as a limit that the rule leaves ungraded: it says `LIMIT_NOT_GRADED`. */
export function pressureUngraded(r: PressureReading, ctx: GradeContext): boolean {
  return (!!r.comparator || !!r.dia?.comparator) && pressureStatus(r, ctx) === null;
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
