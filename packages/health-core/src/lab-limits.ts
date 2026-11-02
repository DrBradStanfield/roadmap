/**
 * Lab results printed as a limit ("> 60", "< 5"): US-12 AC20 (Brad
 * 2026-11-01, "we should be saving the greater than and less than symbols";
 * 2026-11-02, "Only when it decides").
 *
 * The record stores the printed bound in `value` and the symbol in
 * `comparator`, as FHIR's Quantity.comparator does. Only the lab upload sets
 * it. The plan grades a limit only when the bound decides: when no cutoff the
 * plan, the tiles, the grids or the cascades compare that test against lies
 * inside the band the limit leaves open. Then any value in the band grades
 * the same, and the plan grades a representative strictly inside it, which
 * is never shown, stored or sent anywhere. Otherwise the test has no graded
 * value, and is shown with its limit.
 */
import type { HealthInputs } from './types';
import {
  UNIT_DEFS, formatDisplayValue, fromCanonicalValue, type MetricType, type UnitSystem,
  APOB_RISK_ENHANCING, APOB_THRESHOLDS, BP_THRESHOLDS, CREATININE_GRID_BANDS, EGFR_THRESHOLDS, HBA1C_THRESHOLDS,
  HDL_GRID_BANDS, HDL_THRESHOLDS, LDL_THRESHOLDS, LIPID_TREATMENT_TARGETS, LPA_THRESHOLDS, PSA_THRESHOLDS,
  TOTAL_CHOLESTEROL_THRESHOLDS, TRIGLYCERIDES_THRESHOLDS, bpTargetFor,
} from './units';
import { fieldBounds, inRange } from './validation';

/** FHIR Quantity.comparator's codes, as the file stores them. */
export const COMPARATORS = ['<', '<=', '>', '>='] as const;
export type Comparator = (typeof COMPARATORS)[number];

export const isComparator = (v: unknown): v is Comparator => (COMPARATORS as readonly unknown[]).includes(v);

/** How each code prints: ≤ and ≥ in display only, never in the file. */
const SYMBOLS: Record<Comparator, string> = { '<': '<', '<=': '≤', '>': '>', '>=': '≥' };

/** A code's symbol alone: "<", "≤". */
export const comparatorSymbol = (comparator: Comparator): string => SYMBOLS[comparator];

/** A displayed value with its limit's symbol: "> 60", "≤ 5". The text alone when there is none. */
export function withComparator(text: string, comparator?: Comparator | null): string {
  return comparator ? `${SYMBOLS[comparator]} ${text}` : text;
}

/** A row's limit code, to spread into the row or shape it becomes: `{ comparator }` for one of the four codes, else `{}`. */
export function comparatorOf(row: { comparator?: unknown } | null | undefined): { comparator?: Comparator } {
  return isComparator(row?.comparator) ? { comparator: row.comparator } : {};
}

/**
 * A limit's bound as displayed, with its symbol. The metric's own decimal
 * places when they hold the bound exactly ("< 0.01" stays 0.01 at more places
 * than PSA shows); else one place more, rounded away from the band, so the
 * shown limit is still true: 60 mg/dL HDL shown in mmol/L is "> 1.55".
 */
export function limitText(displayed: number, dp: number, comparator: Comparator): string {
  return withComparator(limitNumber(displayed, dp, comparator), comparator);
}

/** `limitText`'s number alone, for a cell that shows the symbol beside it. */
export function limitNumber(displayed: number, dp: number, comparator: Comparator): string {
  for (let places = dp; places <= dp + 4; places++) {
    const fixed = displayed.toFixed(places);
    if (Math.abs(Number(fixed) - displayed) <= 1e-9 * Math.max(1, Math.abs(displayed))) return fixed;
  }
  const scale = 10 ** (dp + 1);
  const steps = Number((displayed * scale).toPrecision(12));
  return ((comparator === '<' || comparator === '<=' ? Math.ceil(steps) : Math.floor(steps)) / scale).toFixed(dp + 1);
}

/** A core metric's limit in a unit system, as `formatDisplayValue` shows an exact value. */
export function formatLimit(metric: MetricType, limit: Pick<InputLimit, 'comparator' | 'bound'>, system: UnitSystem): string {
  return limitText(fromCanonicalValue(metric, limit.bound, system), UNIT_DEFS[metric].decimalPlaces[system], limit.comparator);
}

/** A core value as every surface shows it: a limit with its symbol, rounded away from its band; else `formatDisplayValue`. */
export function formatValue(metric: MetricType, value: number, system: UnitSystem, comparator?: Comparator | null): string {
  return comparator ? formatLimit(metric, { comparator, bound: value }, system) : formatDisplayValue(metric, value, system);
}

/** What a report's symbol is in the file's code. */
const PRINTED: Record<string, Comparator> = { '<': '<', '>': '>', '≤': '<=', '≥': '>=' };

/**
 * A result printed as a limit, split into its code and the text after the
 * symbol: "<5", "< 5", "≤5", "> 60", "≥ 45". Exactly one symbol: "<<5",
 * "<=5" or "< >5" is no limit, so its row stays unreadable. Whether the rest
 * is a number is the caller's reading.
 */
export function readPrintedLimit(text: string): { comparator: Comparator; rest: string } | null {
  const m = /^\s*([<>≤≥])\s*([^<>≤≥=]*)$/.exec(text);
  return m && m[2].trim() ? { comparator: PRINTED[m[1]], rest: m[2] } : null;
}

/** The inputs a lab limit can land in: the graded blood tests and the lab's printed eGFR. */
export type LimitField = 'hba1c' | 'ldlC' | 'totalCholesterol' | 'hdlC' | 'triglycerides' | 'apoB' | 'creatinine'
  | 'psa' | 'lpa' | 'systolicBp' | 'diastolicBp' | 'labEgfr';

const values = (o: object): number[] => Object.values(o).flatMap((v) => (typeof v === 'number' ? [v] : values(v as object)));

/**
 * The plan's grading lines: every cutoff the plan's cards, calculations,
 * gates, targets and medication cascades compare each input against, in its
 * canonical unit, for any sex and any treatment state. A limit is graded by
 * the plan only when it decides against these. Built from the threshold
 * constants, never copied; lab-limits.test.ts fails when a constant or a
 * literal is in neither this list nor `LIMIT_LABEL_CUTOFFS`. Non-HDL's lines
 * are absent on purpose: non-HDL is derived, and never derived from a limit.
 * Creatinine and PSA have none: the plan grades neither directly.
 */
export const LIMIT_CUTOFFS: Readonly<Record<LimitField, readonly number[]>> = {
  hba1c: values(HBA1C_THRESHOLDS),
  ldlC: [...values(LDL_THRESHOLDS), LIPID_TREATMENT_TARGETS.ldlMmol],
  totalCholesterol: values(TOTAL_CHOLESTEROL_THRESHOLDS),
  hdlC: values(HDL_THRESHOLDS),
  triglycerides: [TRIGLYCERIDES_THRESHOLDS.borderline, TRIGLYCERIDES_THRESHOLDS.veryHigh],
  apoB: [...values(APOB_THRESHOLDS), LIPID_TREATMENT_TARGETS.apobGl, APOB_RISK_ENHANCING],
  creatinine: [],
  psa: [],
  lpa: values(LPA_THRESHOLDS),
  systolicBp: [BP_THRESHOLDS.stage1Sys, BP_THRESHOLDS.stage2Sys, BP_THRESHOLDS.crisisSys, bpTargetFor(undefined), bpTargetFor(65)],
  diastolicBp: [BP_THRESHOLDS.stage1Dia, BP_THRESHOLDS.stage2Dia, BP_THRESHOLDS.crisisDia],
  labEgfr: [EGFR_THRESHOLDS.mildlyDecreased],
};

/**
 * The label lines: what the tiles' status words and the blood-test grids'
 * colours compare each input against (the vitals grid's systolic target
 * too). A limit the plan grades shows a tile word or a grid colour only when
 * it also decides against these; otherwise it shows with no word and no
 * colour (the orchestrator, 2026-11-02: eGFR's 70 line drives only a label).
 */
export const LIMIT_LABEL_CUTOFFS: Readonly<Record<LimitField, readonly number[]>> = {
  hba1c: values(HBA1C_THRESHOLDS),
  ldlC: values(LDL_THRESHOLDS),
  totalCholesterol: values(TOTAL_CHOLESTEROL_THRESHOLDS),
  hdlC: values(HDL_GRID_BANDS),
  triglycerides: [TRIGLYCERIDES_THRESHOLDS.borderline, TRIGLYCERIDES_THRESHOLDS.high],
  apoB: values(APOB_THRESHOLDS),
  creatinine: values(CREATININE_GRID_BANDS),
  psa: values(PSA_THRESHOLDS),
  lpa: values(LPA_THRESHOLDS),
  systolicBp: [BP_THRESHOLDS.elevatedSys, bpTargetFor(undefined), bpTargetFor(65)],
  diastolicBp: [BP_THRESHOLDS.stage1Dia],
  labEgfr: values(EGFR_THRESHOLDS),
};

export const isLimitField = (field: string): field is LimitField => Object.prototype.hasOwnProperty.call(LIMIT_CUTOFFS, field);

/** Each input's SI display places, for a limit said in SI (agents, the chat, the eGFR and Lp(a) tiles). */
const SI_PLACES: Readonly<Record<LimitField, number>> = {
  hba1c: UNIT_DEFS.hba1c.decimalPlaces.si, ldlC: UNIT_DEFS.ldl.decimalPlaces.si, totalCholesterol: UNIT_DEFS.total_cholesterol.decimalPlaces.si,
  hdlC: UNIT_DEFS.hdl.decimalPlaces.si, triglycerides: UNIT_DEFS.triglycerides.decimalPlaces.si, apoB: UNIT_DEFS.apob.decimalPlaces.si,
  creatinine: UNIT_DEFS.creatinine.decimalPlaces.si, psa: UNIT_DEFS.psa.decimalPlaces.si, lpa: UNIT_DEFS.lpa.decimalPlaces.si,
  systolicBp: UNIT_DEFS.systolic_bp.decimalPlaces.si, diastolicBp: UNIT_DEFS.diastolic_bp.decimalPlaces.si, labEgfr: 0,
};

/** A limit as printed in its input's SI unit, "> 1.5", rounded away from its band: never a float's raw digits. */
export function limitSIText(field: LimitField, limit: Pick<InputLimit, 'comparator' | 'bound'>): string {
  return limitText(limit.bound, SI_PLACES[field], limit.comparator);
}

/**
 * The plan's eGFR as an agent or the chat reads it: a lab eGFR printed as a
 * limit as printed ("> 90"), never the representative; else the number. A
 * known minor's adult reading is withheld either way (`adult` absent).
 */
export function egfrAsPrinted(inputs: Pick<Partial<HealthInputs>, 'limits'>, adult: { eGFR?: number } | null | undefined): number | string | undefined {
  const limit = inputs.limits?.labEgfr;
  return limit ? (adult ? limitSIText('labEgfr', limit) : undefined) : adult?.eGFR;
}

/**
 * The value a tile word or a grid colour grades a limit with: the plan's
 * representative, only when the limit also decides against the label lines;
 * null when it does not, so the surface shows the limit with no word or colour.
 */
export function limitLabelValue(field: LimitField, comparator: Comparator, bound: number): number | null {
  const value = limitRepresentative(field, comparator, bound);
  return value !== null && bandDecides(LIMIT_LABEL_CUTOFFS[field], comparator, bound) ? value : null;
}

/**
 * Whether a limit decides against every cutoff in a list (an input's lines,
 * or a non-core lab's reference range): `< b` when every cutoff is at or
 * above b; `<= b` when every one is above b; `> b` when every one is at or
 * below b; `>= b` when every one is below b. The same lists for everyone,
 * never per sex: conservative on purpose.
 */
export function bandDecides(cutoffs: readonly number[], comparator: Comparator, bound: number): boolean {
  switch (comparator) {
    case '<': return cutoffs.every((c) => c >= bound);
    case '<=': return cutoffs.every((c) => c > bound);
    case '>': return cutoffs.every((c) => c <= bound);
    case '>=': return cutoffs.every((c) => c < bound);
  }
}

/** How far inside a strict bound a limit's grade is read: never across a line. */
const insideStep = (bound: number) => Math.max(1e-6, Math.abs(bound) * 1e-6);

/**
 * The one rule for grading a value printed as a limit against a grade's own
 * lines (Brad 2026-11-02, "grade only when certain", US-12 AC21): when no
 * line lies inside the band the limit leaves open (`bandDecides`), every
 * value the limit allows grades the same, so the grade may read the number a
 * hair inside the band, returned here; null when a line lies inside it, so
 * the value gets no grade. An exact value (no comparator) is itself. Never
 * shown, stored or sent.
 */
export function certainValue(lines: readonly number[], comparator: Comparator | undefined, bound: number): number | null {
  if (!comparator) return bound;
  if (!Number.isFinite(bound) || !bandDecides(lines, comparator, bound)) return null;
  return comparator === '<' || comparator === '<=' ? bound - insideStep(bound) : bound + insideStep(bound);
}

/**
 * How many of a grade's lines the values a reading allows have reached
 * (a line is reached at or above it): [fewest, most], worked out exactly from
 * which side of each line the bound lies and whether it is strict, never by
 * nudging a number. An exact value reaches the lines at or below it; "< b"
 * reaches at most those strictly below b, "<= b" those at or below b; "> b"
 * and ">= b" reach at least those at or below b, and every line at most. For
 * a grade that is the count of lines reached (a blood pressure half's), the
 * grade is certain when the two agree (US-12 AC21).
 */
export function linesReached(lines: readonly number[], comparator: Comparator | undefined, bound: number): [number, number] {
  const below = lines.filter((line) => line < bound).length;
  const atOrBelow = lines.filter((line) => line <= bound).length;
  switch (comparator) {
    case '<': return [0, below];
    case '<=': return [0, atOrBelow];
    case '>': case '>=': return [atOrBelow, lines.length];
    default: return [atOrBelow, atOrBelow];
  }
}

/**
 * A non-core lab graded by its printed reference range: the number it is
 * graded with, a hair inside the band, when no bound of the range lies in
 * the band; null when one does, so it gets no colour.
 */
export function referenceGradeValue(limit: Pick<InputLimit, 'comparator' | 'bound'>, referenceLow?: number | null, referenceHigh?: number | null): number | null {
  // A bound of exactly 0 is no cutoff: CRP's printed "0-5" must not leave every "< x" undecided.
  // A negative bound is one (base excess "-2 to 2").
  const cutoffs = [referenceLow, referenceHigh].filter((c): c is number => typeof c === 'number' && Number.isFinite(c) && c !== 0);
  return certainValue(cutoffs, limit.comparator, limit.bound);
}

/**
 * The value the plan grades a limit with: strictly inside the band the limit
 * leaves open, halfway to the schema's far bound, so no rounding moves it
 * across the bound. Null when the limit does not decide, or no such value
 * passes the schema: the input then has no graded value.
 */
export function limitRepresentative(field: LimitField, comparator: Comparator, bound: number): number | null {
  if (!Number.isFinite(bound) || !bandDecides(LIMIT_CUTOFFS[field], comparator, bound)) return null;
  const { min, max } = fieldBounds(field)!;
  const below = comparator === '<' || comparator === '<=';
  const value = below ? (min + bound) / 2 : (bound + max) / 2;
  const inBand = below ? value < bound : value > bound;
  return inBand && inRange(field, value) ? value : null;
}

/** A limit as the inputs carry it: the printed bound, its code, and whether the plan grades it. */
export interface InputLimit {
  comparator: Comparator;
  /** The printed bound, canonical unit. The only number a surface shows. */
  bound: number;
  /** True when the field holds the representative; false when it holds nothing. */
  graded: boolean;
}

export type InputLimits = Partial<Record<LimitField, InputLimit>>;

/**
 * `inputs` with `field` read from a row: an exact value as before, or a limit,
 * whose representative the field holds only when it decides. Either way the
 * field's old limit, if any, goes, so a typed value is never marked a limit.
 */
export function withRowValue<T extends Partial<HealthInputs>>(inputs: T, field: keyof HealthInputs, value: number, comparator?: Comparator | null): T {
  const { limits, [field]: _f, ...others } = inputs as Record<string, unknown>;
  const rest = withoutLimit(limits as InputLimits | undefined, field);
  if (!comparator || !isLimitField(field)) return { ...others, ...rest, [field]: value } as T;
  const representative = limitRepresentative(field, comparator, value);
  return {
    ...others,
    ...(representative === null ? {} : { [field]: representative }),
    limits: { ...rest.limits, [field]: { comparator, bound: value, graded: representative !== null } },
  } as T;
}

/** `{ limits }` without `field`'s, or `{}` when none is left: spread over inputs that drop the key. */
export function withoutLimit(limits: InputLimits | undefined, field: string): { limits?: InputLimits } {
  const { [field as LimitField]: _dropped, ...rest } = limits ?? {};
  return Object.keys(rest).length ? { limits: rest } : {};
}

/** The field's limit, if it holds one. */
export function limitOf(inputs: Pick<Partial<HealthInputs>, 'limits'> | undefined, field: string): InputLimit | undefined {
  return isLimitField(field) ? inputs?.limits?.[field] : undefined;
}

/** What a surface says beside a limit it cannot grade (US-12 AC20). */
export const LIMIT_NOT_GRADED = 'Printed as a limit, so the plan cannot grade it against its cutoff.';

/**
 * US-12 AC20's usage signal (`upload_outcome` `valuesLimitUngraded`): an
 * uploaded limit the rule leaves undecided, judged at upload by the same
 * cutoffs. A core test by its input's cutoffs, the lab eGFR by eGFR's, any
 * other lab by its printed reference range.
 */
export function uploadLimitUngraded(value: { comparator?: Comparator; field?: string; valueSI?: number; value?: number; referenceLow?: number | null; referenceHigh?: number | null }): boolean {
  if (!value.comparator) return false;
  const bound = value.valueSI ?? value.value ?? NaN;
  if (value.field && isLimitField(value.field)) return limitRepresentative(value.field, value.comparator, bound) === null;
  return referenceGradeValue({ comparator: value.comparator, bound }, value.referenceLow, value.referenceHigh) === null;
}
