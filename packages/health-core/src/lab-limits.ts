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
  UNIT_DEFS, fromCanonicalValue, type MetricType, type UnitSystem,
  APOB_RISK_ENHANCING, APOB_THRESHOLDS, BP_THRESHOLDS, CREATININE_GRID_BANDS, EGFR_THRESHOLDS, HBA1C_THRESHOLDS,
  HDL_GRID_BANDS, HDL_THRESHOLDS, LDL_THRESHOLDS, LIPID_TREATMENT_TARGETS, LPA_THRESHOLDS, PSA_THRESHOLDS,
  TOTAL_CHOLESTEROL_THRESHOLDS, TRIGLYCERIDES_THRESHOLDS, bpTargetFor,
} from './units';
import { healthInputSchema, sanitizeInputs } from './validation';

/** FHIR Quantity.comparator's codes, as the file stores them. */
export const COMPARATORS = ['<', '<=', '>', '>='] as const;
export type Comparator = (typeof COMPARATORS)[number];

export const isComparator = (v: unknown): v is Comparator => (COMPARATORS as readonly unknown[]).includes(v);

/** How each code prints: ≤ and ≥ in display only, never in the file. */
const SYMBOLS: Record<Comparator, string> = { '<': '<', '<=': '≤', '>': '>', '>=': '≥' };

/** A displayed value with its limit's symbol: "> 60", "≤ 5". The text alone when there is none. */
export function withComparator(text: string, comparator?: Comparator | null): string {
  return comparator ? `${SYMBOLS[comparator]} ${text}` : text;
}

/**
 * A limit's bound as displayed, with its symbol. The metric's own decimal
 * places when they hold the bound exactly ("< 0.01" stays 0.01 at more places
 * than PSA shows); else one place more, rounded away from the band, so the
 * shown limit is still true: 60 mg/dL HDL shown in mmol/L is "> 1.55".
 */
export function limitText(displayed: number, dp: number, comparator: Comparator): string {
  for (let places = dp; places <= dp + 4; places++) {
    const fixed = displayed.toFixed(places);
    if (Math.abs(Number(fixed) - displayed) <= 1e-9 * Math.max(1, Math.abs(displayed))) return withComparator(fixed, comparator);
  }
  const scale = 10 ** (dp + 1);
  const steps = Number((displayed * scale).toPrecision(12));
  const rounded = (comparator === '<' || comparator === '<=' ? Math.ceil(steps) : Math.floor(steps)) / scale;
  return withComparator(rounded.toFixed(dp + 1), comparator);
}

/** A core metric's limit in a unit system, as `formatDisplayValue` shows an exact value. */
export function formatLimit(metric: MetricType, limit: Pick<InputLimit, 'comparator' | 'bound'>, system: UnitSystem): string {
  return limitText(fromCanonicalValue(metric, limit.bound, system), UNIT_DEFS[metric].decimalPlaces[system], limit.comparator);
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
 * Every cutoff anything compares each input against, in its canonical unit,
 * for any sex and any treatment state: the plan, its tiles, the blood-test
 * grids' colours, the cards and the medication cascades. Built from the
 * threshold constants, never copied from them; lab-limits.test.ts fails when
 * a constant or a literal is missing. Non-HDL's thresholds are absent on
 * purpose: non-HDL is derived, and never derived from a limit.
 */
export const LIMIT_CUTOFFS: Readonly<Record<LimitField, readonly number[]>> = {
  hba1c: values(HBA1C_THRESHOLDS),
  ldlC: [...values(LDL_THRESHOLDS), LIPID_TREATMENT_TARGETS.ldlMmol],
  totalCholesterol: values(TOTAL_CHOLESTEROL_THRESHOLDS),
  hdlC: [...values(HDL_THRESHOLDS), ...values(HDL_GRID_BANDS)],
  triglycerides: values(TRIGLYCERIDES_THRESHOLDS),
  apoB: [...values(APOB_THRESHOLDS), LIPID_TREATMENT_TARGETS.apobGl, APOB_RISK_ENHANCING],
  creatinine: values(CREATININE_GRID_BANDS),
  psa: values(PSA_THRESHOLDS),
  lpa: values(LPA_THRESHOLDS),
  systolicBp: [BP_THRESHOLDS.elevatedSys, BP_THRESHOLDS.stage1Sys, BP_THRESHOLDS.stage2Sys, BP_THRESHOLDS.crisisSys, bpTargetFor(undefined), bpTargetFor(65)],
  diastolicBp: [BP_THRESHOLDS.stage1Dia, BP_THRESHOLDS.stage2Dia, BP_THRESHOLDS.crisisDia],
  labEgfr: values(EGFR_THRESHOLDS),
};

export const isLimitField = (field: string): field is LimitField => Object.prototype.hasOwnProperty.call(LIMIT_CUTOFFS, field);

/**
 * Whether a limit decides against every cutoff of `field`: `< b` when every
 * cutoff is at or above b; `<= b` when every one is above b; `> b` when every
 * one is at or below b; `>= b` when every one is below b. One list for
 * everyone, never per sex: conservative on purpose.
 */
export function limitDecides(field: LimitField, comparator: Comparator, bound: number): boolean {
  return bandDecides(LIMIT_CUTOFFS[field], comparator, bound);
}

/** The same rule against any list of cutoffs: a non-core lab's own reference range, say. */
export function bandDecides(cutoffs: readonly number[], comparator: Comparator, bound: number): boolean {
  switch (comparator) {
    case '<': return cutoffs.every((c) => c >= bound);
    case '<=': return cutoffs.every((c) => c > bound);
    case '>': return cutoffs.every((c) => c <= bound);
    case '>=': return cutoffs.every((c) => c < bound);
  }
}

/**
 * A non-core lab graded by its printed reference range: the number it is
 * graded with, a hair inside the band, when no bound of the range lies in
 * the band; null when one does, so it gets no colour.
 */
export function referenceGradeValue(limit: Pick<InputLimit, 'comparator' | 'bound'>, referenceLow?: number | null, referenceHigh?: number | null): number | null {
  const cutoffs = [referenceLow, referenceHigh].filter((c): c is number => typeof c === 'number' && Number.isFinite(c));
  if (!bandDecides(cutoffs, limit.comparator, limit.bound)) return null;
  const step = Math.max(1e-6, Math.abs(limit.bound) * 1e-6);
  return limit.comparator === '<' || limit.comparator === '<=' ? limit.bound - step : limit.bound + step;
}

/** The schema's own bounds for a field (`minValue`, `maxValue` of its number). */
function schemaBounds(field: LimitField): { min: number; max: number } {
  const schema = (healthInputSchema.shape[field] as unknown as { unwrap(): { minValue: number | null; maxValue: number | null } }).unwrap();
  return { min: schema.minValue ?? 0, max: schema.maxValue ?? 0 };
}

/**
 * The value the plan grades a limit with: strictly inside the band the limit
 * leaves open, halfway to the schema's far bound, so no rounding moves it
 * across the bound. Null when the limit does not decide, or no such value
 * passes the schema: the input then has no graded value.
 */
export function limitRepresentative(field: LimitField, comparator: Comparator, bound: number): number | null {
  if (!Number.isFinite(bound) || !limitDecides(field, comparator, bound)) return null;
  const { min, max } = schemaBounds(field);
  const below = comparator === '<' || comparator === '<=';
  const value = below ? (min + bound) / 2 : (bound + max) / 2;
  const inBand = below ? value < bound : value > bound;
  return inBand && field in sanitizeInputs({ [field]: value }) ? value : null;
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
  const { [field as LimitField]: _old, ...rest } = inputs.limits ?? {};
  const limits = Object.keys(rest).length ? { limits: rest as InputLimits } : {};
  const { limits: _l, [field]: _f, ...others } = inputs as Record<string, unknown>;
  if (!comparator || !isLimitField(field)) return { ...others, ...limits, [field]: value } as T;
  const representative = limitRepresentative(field, comparator, value);
  return {
    ...others,
    ...(representative === null ? {} : { [field]: representative }),
    limits: { ...rest, [field]: { comparator, bound: value, graded: representative !== null } },
  } as T;
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
