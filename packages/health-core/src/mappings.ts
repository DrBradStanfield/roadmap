/**
 * Shared mappings between HealthInputs fields and measurement metric types.
 *
 * Used by the storefront widget to convert between API measurement
 * records and HealthInputs objects.
 *
 * Demographics (sex, birthYear, birthMonth, unitSystem) are stored on the
 * profiles table, not as measurements. Use diffProfileFields() for those.
 */
import type { AlcoholAnswer, HealthInputs } from './types';
import { encodeSex, decodeSex, encodeUnitSystem, decodeUnitSystem, isAlcoholAnswer, isSex } from './types';
import { CANONICAL_UNITS, rangeFault, UNIT_DEFS, type MetricType, type ValidationRange } from './units';
import type { ApiScreening } from './screening-inputs';
import { birthKept } from './validation';
import { comparatorOf, limitOf, limitRepresentative, withRowValue } from './lab-limits';

/**
 * Maps HealthInputs field names to metric_type values for storage in the
 * health_measurements table. Used when saving longitudinal measurements.
 *
 * NOTE: Excludes heightCm because height is stored on the profiles table,
 * not as a time-series measurement. For unit conversions (which include
 * height), use FIELD_METRIC_MAP instead.
 */
export const FIELD_TO_METRIC: Record<string, string> = {
  weightKg: 'weight',
  waistCm: 'waist',
  hba1c: 'hba1c',
  ldlC: 'ldl',
  totalCholesterol: 'total_cholesterol',
  hdlC: 'hdl',
  triglycerides: 'triglycerides',
  systolicBp: 'systolic_bp',
  diastolicBp: 'diastolic_bp',
  apoB: 'apob',
  creatinine: 'creatinine',
  psa: 'psa',
  lpa: 'lpa',
};

/** Reverse mapping: metric_type → HealthInputs field name. */
export const METRIC_TO_FIELD: Record<string, keyof HealthInputs> = {
  weight: 'weightKg',
  waist: 'waistCm',
  hba1c: 'hba1c',
  ldl: 'ldlC',
  total_cholesterol: 'totalCholesterol',
  hdl: 'hdlC',
  triglycerides: 'triglycerides',
  systolic_bp: 'systolicBp',
  diastolic_bp: 'diastolicBp',
  apob: 'apoB',
  creatinine: 'creatinine',
  psa: 'psa',
  lpa: 'lpa',
};

/**
 * Maps HealthInputs field names to MetricType for unit conversions.
 * Used by UI components to convert between SI and conventional units.
 *
 * NOTE: Includes heightCm (unlike FIELD_TO_METRIC) because height requires
 * unit conversion even though it's stored on profiles, not measurements.
 */
export const FIELD_METRIC_MAP: Record<string, MetricType> = {
  heightCm: 'height',
  weightKg: 'weight',
  waistCm: 'waist',
  hba1c: 'hba1c',
  ldlC: 'ldl',
  totalCholesterol: 'total_cholesterol',
  hdlC: 'hdl',
  triglycerides: 'triglycerides',
  systolicBp: 'systolic_bp',
  diastolicBp: 'diastolic_bp',
  apoB: 'apob',
  creatinine: 'creatinine',
  psa: 'psa',
  lpa: 'lpa',
};

/** The SI unit each input field holds, keyed by field (US-32 AC35): `get_plan` and the chat context publish it. */
export const FIELD_UNITS: Record<string, string> = Object.fromEntries(
  Object.entries(FIELD_METRIC_MAP).map(([field, metric]) => [field, CANONICAL_UNITS[metric]]),
);

/** Human-readable display names for metric types. */
export const METRIC_LABELS: Record<string, string> = {
  weight: 'Weight',
  waist: 'Waist',
  hba1c: 'HbA1c',
  ldl: 'LDL Cholesterol',
  hdl: 'HDL Cholesterol',
  triglycerides: 'Triglycerides',
  total_cholesterol: 'Total Cholesterol',
  apob: 'ApoB',
  systolic_bp: 'Systolic BP',
  diastolic_bp: 'Diastolic BP',
  creatinine: 'Creatinine',
  psa: 'PSA',
  lpa: 'Lp(a)',
};

/**
 * Fields that are always pre-filled from saved data (demographics + height,
 * and the alcohol answer, US-60).
 * These are mutable profile-level data or rarely-changing measurements.
 */
export const PREFILL_FIELDS: ReadonlyArray<keyof HealthInputs> = [
  'heightCm', 'sex', 'birthYear', 'birthMonth', 'alcohol',
];

/**
 * Does the form hold a demographics edit that has not been saved yet? US-34's
 * remote-change listener asks before it re-runs its load path: a record
 * arriving mid-typing would otherwise replace a half-entered birth year with
 * the stored one and take the keystrokes with it. The store keeps the merge
 * either way — the next save carries the edit up, and the page catches up then.
 */
export function hasUnsavedProfileEdits(
  current: Partial<HealthInputs>,
  saved: Partial<HealthInputs>,
): boolean {
  return PREFILL_FIELDS.some((f) => current[f] !== saved[f]);
}

/**
 * Fields that use longitudinal UX: empty input + "Previous: value (date)" label.
 * These are immutable time-series measurements that accumulate over time.
 */
export const LONGITUDINAL_FIELDS: ReadonlyArray<keyof HealthInputs> = [
  'weightKg', 'waistCm', 'hba1c', 'creatinine', 'psa', 'apoB', 'ldlC', 'totalCholesterol', 'hdlC',
  'triglycerides', 'systolicBp', 'diastolicBp', 'lpa',
];

/**
 * Fill the longitudinal fields a form left empty from the user's saved rows —
 * the "what am I actually being assessed on" step between stored measurements
 * and `calculateHealthResults`. A field the caller already holds always wins
 * (typing a new value must not be overridden by history), and `previous` is
 * expected to hold ONE row per metric — the newest active one, per US-07 AC4 —
 * so the first match for a metric is its current value.
 */
export function mergeLongitudinalInputs(
  inputs: Partial<HealthInputs>,
  previous: ReadonlyArray<Pick<ApiMeasurement, 'metricType' | 'value' | 'comparator'>>,
): Partial<HealthInputs> {
  let base = { ...inputs };
  for (const m of previous) {
    const field = METRIC_TO_FIELD[m.metricType];
    // A saved limit is read by the plan's one rule (US-12 AC20); a value typed over it wins, as any typed value does.
    if (field && (LONGITUDINAL_FIELDS as readonly string[]).includes(field) && base[field] === undefined && !limitOf(base, field)) {
      base = withRowValue(base, field, m.value, m.comparator);
    }
  }
  return base;
}

/**
 * Metric types for blood test results (as opposed to body measurements).
 * Used to determine which measurements should use the user-selected blood test date.
 */
export const BLOOD_TEST_METRICS: ReadonlyArray<string> = [
  'hba1c', 'creatinine', 'psa', 'apob', 'ldl', 'total_cholesterol', 'hdl', 'triglycerides', 'lpa',
];

/** Metric types for the vitals (the body measurements the vitals matrix shows). */
export const VITAL_METRICS: ReadonlyArray<string> = ['weight', 'waist', 'systolic_bp', 'diastolic_bp'];

/** API measurement record shape (camelCase, as returned by API endpoints). */
export interface ApiMeasurement {
  id: string;
  metricType: string;
  value: number;
  recordedAt: string;
  createdAt: string;
  // Optional fields used only by audit-mode UI; older API responses may omit.
  source?: import('./validation').MeasurementSource;
  externalId?: string | null;
  status?: import('./validation').MeasurementStatus;
  correctsId?: string | null;
  /** A lab result printed as a limit: `value` is its bound (US-12 AC20). */
  comparator?: import('./lab-limits').Comparator;
}

/** API medication record shape (camelCase, as returned by API endpoints). FHIR-compatible. */
export interface ApiMedication {
  id: string;
  medicationKey: string;
  drugName: string;           // e.g., 'atorvastatin', 'yes', 'not_yet'
  doseValue: number | null;   // e.g., 40, null for non-drug fields
  doseUnit: string | null;    // e.g., 'mg', null for non-drug fields
  updatedAt: string;
}

/**
 * Convert API medication records into a MedicationInputs object.
 * Handles FHIR-compliant data (actual drug names) and converts to UI format.
 */
export function medicationsToInputs(
  medications: ReadonlyArray<Pick<ApiMedication, 'medicationKey' | 'drugName' | 'doseValue'>>,
): import('./types').MedicationInputs {
  const inputs: import('./types').MedicationInputs = {};
  for (const m of medications) {
    // A name that is not a string (null, a number or an object in a
    // hand-edited file) is unanswered, as if no row were recorded.
    if (typeof m.drugName !== 'string') continue;
    switch (m.medicationKey) {
      case 'statin':
        inputs.statin = {
          drug: m.drugName,
          dose: m.doseValue,
        };
        break;
      case 'ezetimibe':
        // FHIR-compliant: 'ezetimibe' with dose means taking it, convert to 'yes'
        if (m.drugName === 'ezetimibe' && m.doseValue !== null) {
          inputs.ezetimibe = 'yes';
        } else {
          inputs.ezetimibe = m.drugName as 'not_yet' | 'yes' | 'no' | 'not_tolerated';
        }
        break;
      case 'statin_escalation':
        inputs.statinEscalation = m.drugName as 'not_yet' | 'not_tolerated';
        break;
      case 'bempedoic_acid':
        inputs.bempedoicAcid = m.drugName as import('./types').BempedoicAcidValue;
        break;
      case 'pcsk9i':
        // FHIR-compliant: 'pcsk9i' with dose means taking it, convert to 'yes'
        if (m.drugName === 'pcsk9i' && m.doseValue !== null) {
          inputs.pcsk9i = 'yes';
        } else {
          inputs.pcsk9i = m.drugName as 'not_yet' | 'yes' | 'no' | 'not_tolerated';
        }
        break;
      // Weight & diabetes cascade
      case 'glp1':
        inputs.glp1 = { drug: m.drugName, dose: m.doseValue };
        break;
      case 'glp1_escalation':
        inputs.glp1Escalation = m.drugName as 'not_yet' | 'not_tolerated';
        break;
      case 'sglt2i':
        inputs.sglt2i = { drug: m.drugName, dose: m.doseValue };
        break;
      case 'metformin':
        inputs.metformin = m.drugName as import('./types').MetforminValue;
        break;
    }
  }
  return inputs;
}

// The screening read path lives in screening-inputs.ts (split for Change 2b); its importers keep this path.
export { SCREENING_RANGES, screeningRange, screeningsToInputs, type ApiScreening } from './screening-inputs';

/** In the PSA range (0 to 10,000 ng/mL), the one a row and an old answer must both meet. */
export const inPsaRange = (value: number | undefined): value is number => {
  const { min, max } = UNIT_DEFS.psa.validationRange.si;
  return value !== undefined && value >= min && value <= max;
};

/**
 * US-06 AC14: the PSA the plan's prostate cards and PSA reminder read. PSA is
 * a measurement now (no client writes `prostate_psa_value` or
 * `prostate_last_date` any more), so the saved PSA (`newestUsablePsa`, which
 * has checked its range and day) stands in for both, value and day together.
 * The newer by date wins over the old answers; in the same month the row
 * wins, since the answer gives no day. A PSA printed as a limit is graded
 * only when the limit decides against 4.0 (US-12 AC20): otherwise it has no
 * value, and its day still counts; `planPsa`'s `raisedBefore` rides on the
 * limit (US-06 AC21 item 6). An old answer whose value fails `inPsaRange`
 * never wins, whatever its date: the row stands.
 */
export function withPsaMeasurement(
  screenings: import('./types').ScreeningInputs,
  psa: { value: number; recordedAt: string; comparator?: unknown; raisedBefore?: true } | undefined,
): import('./types').ScreeningInputs {
  const day = psa?.recordedAt.slice(0, 10);
  const unusable = screenings.prostatePsaValue !== undefined && !inPsaRange(screenings.prostatePsaValue);
  if (!psa || !day || (!unusable && (screenings.prostateLastDate ?? '') > day)) return screenings;
  const { comparator } = comparatorOf(psa);
  if (!comparator) return { ...screenings, prostatePsaValue: psa.value, prostatePsaLimit: undefined, prostateLastDate: day };
  const graded = limitRepresentative('psa', comparator, psa.value);
  const limit = { comparator, bound: psa.value, ...(psa.raisedBefore && graded === null && { raisedBefore: true as const }) };
  return { ...screenings, prostatePsaValue: graded ?? undefined, prostatePsaLimit: limit, prostateLastDate: day };
}

/** API profile shape (camelCase, as returned by API endpoints). */
export interface ApiProfile {
  sex: number | null;
  birthYear: number | null;
  birthMonth: number | null;
  unitSystem: number | null;
  firstName: string | null;
  lastName: string | null;
  height: number | null;
  /** US-60: the alcohol answer; absent or null when not answered. */
  alcohol?: AlcoholAnswer | null;
}

/**
 * Convert API measurement records + optional profile data into a partial HealthInputs object.
 * Profile demographics (sex, birthYear, birthMonth, unitSystem) come from the profile object.
 */
export function measurementsToInputs(
  measurements: ApiMeasurement[],
  profile?: ApiProfile | null,
): Partial<HealthInputs> {
  let inputs: Partial<HealthInputs> = {};
  for (const m of measurements) {
    const field = METRIC_TO_FIELD[m.metricType];
    if (!field) continue;
    // A limit, or a value over one, goes through the plan's rule (US-12 AC20);
    // every other row is assigned in place, so the mount path stays O(rows).
    if (m.comparator || limitOf(inputs, field)) inputs = withRowValue(inputs, field, m.value, m.comparator);
    else (inputs as Record<string, unknown>)[field] = m.value;
  }

  if (profile) {
    if (profile.sex != null) {
      (inputs as any).sex = decodeSex(profile.sex);
    }
    if (profile.birthYear != null) {
      (inputs as any).birthYear = profile.birthYear;
    }
    if (profile.birthMonth != null) {
      (inputs as any).birthMonth = profile.birthMonth;
    }
    if (profile.unitSystem != null) {
      (inputs as any).unitSystem = decodeUnitSystem(profile.unitSystem);
    }
    if (profile.height != null) {
      (inputs as any).heightCm = profile.height;
    }
    // The file may be hand-edited: only the two answers count (US-60).
    if (isAlcoholAnswer(profile.alcohol)) {
      inputs.alcohol = profile.alcohol;
    }
  }

  return inputs;
}

/**
 * Determine which health measurement fields changed and return them as metric/value pairs
 * ready for the API. Only includes health metrics — use diffProfileFields() for demographics.
 */
export function diffInputsToMeasurements(
  current: Partial<HealthInputs>,
  previous: Partial<HealthInputs>,
): Array<{ metricType: string; value: number }> {
  const changes: Array<{ metricType: string; value: number }> = [];

  for (const [field, metricType] of Object.entries(FIELD_TO_METRIC)) {
    const currentVal = current[field as keyof HealthInputs];
    const previousVal = previous[field as keyof HealthInputs];

    if (currentVal !== undefined && currentVal !== previousVal) {
      changes.push({ metricType, value: currentVal as number });
    }
  }

  return changes;
}

/**
 * Check if an API response contains meaningful user-entered health data.
 * An auto-created profile row with all NULL fields does NOT count as "has data."
 *
 * Used by both sync-embed.liquid (duplicated in plain JS) and HealthTool.tsx
 * to decide whether localStorage→cloud sync should be skipped.
 *
 * Bug history: Before this check, the code used `!!profile` which is always
 * truthy for auto-created profile rows ({sex: null, birthYear: null, ...}),
 * causing sync to never run for new users.
 */
export function hasCloudData(
  profile: ApiProfile | null | undefined,
  measurements: ApiMeasurement[],
  medications?: ApiMedication[],
  screenings?: ApiScreening[],
): boolean {
  if (measurements.length > 0) return true;
  if (medications && medications.length > 0) return true;
  if (screenings && screenings.length > 0) return true;
  if (profile && (
    profile.sex != null ||
    profile.birthYear != null ||
    profile.height != null ||
    profile.unitSystem != null
  )) return true;
  return false;
}

/**
 * Determine which profile fields changed and return them as API-ready numeric values.
 * Encodes sex (1=male, 2=female) and unitSystem (1=si, 2=conventional).
 * Height is stored directly in cm.
 * Returns null if nothing changed.
 */
export function diffProfileFields(
  current: Partial<HealthInputs>,
  previous: Partial<HealthInputs>,
): { sex?: number; birthYear?: number; birthMonth?: number; unitSystem?: number; height?: number } | null {
  const changes: Record<string, number> = {};

  if (current.sex !== undefined && current.sex !== previous.sex) {
    changes.sex = encodeSex(current.sex);
  }
  if (current.birthYear !== undefined && current.birthYear !== previous.birthYear) {
    changes.birthYear = current.birthYear;
  }
  if (current.birthMonth !== undefined && current.birthMonth !== previous.birthMonth) {
    changes.birthMonth = current.birthMonth;
  }
  if (current.unitSystem !== undefined && current.unitSystem !== previous.unitSystem) {
    changes.unitSystem = encodeUnitSystem(current.unitSystem);
  }
  if (current.heightCm !== undefined && current.heightCm !== previous.heightCm) {
    changes.height = current.heightCm;
  }

  return Object.keys(changes).length > 0 ? changes : null;
}

/** The onboarding step the form is on: 1–3, or 4 once it is done. */
export type FormStage = 1 | 2 | 3 | 4;

/**
 * The form is the onboarding (US-01 AC1, US-62 AC13): the stage is the first
 * answer the record lacks. The widget shows it, and the chatbot embed unmutes
 * at 4, so both read this one rule (US-15 AC10).
 *
 * Stage 1: a plausible height and weight (the BMI tile)
 * Stage 2: sex (the healthy weight and the protein target)
 * Stage 3: the birth year, with its month when given (the age-based plan)
 * Stage 4: all four known: the rest of the form, the chat and the embed
 *
 * `saved` holds the newest saved row per metric; they fill the fields the
 * inputs leave empty (mergeLongitudinalInputs), so a typed value wins.
 * "Plausible" = inside the canonical SI validation range (UNIT_DEFS in
 * units.ts) — a half-typed "1" of "180" must NOT open the next stage; the
 * gate opens only once the value could be a real measurement. The birth date
 * counts once the plan would keep it: a year from 1900, alone (the plan reads
 * January, as the iPhone does) or with a month not in the future. The form
 * asks both.
 */
export function computeFormStage(
  inputs: Partial<HealthInputs>,
  saved: ReadonlyArray<Pick<ApiMeasurement, 'metricType' | 'value'>> = [],
): FormStage {
  const merged = mergeLongitudinalInputs(inputs, saved);
  if (!plausible(merged.heightCm, UNIT_DEFS.height.validationRange.si)) return 1;
  if (!plausible(merged.weightKg, UNIT_DEFS.weight.validationRange.si)) return 1;
  if (!isSex(merged.sex)) return 2;
  return birthKept(merged) ? 4 : 3;
}
const plausible = (v: number | undefined, r: ValidationRange) => v !== undefined && !rangeFault(r, v);

/** The weight step is still open on the saved record: it holds no plausible
 *  weight, as computeFormStage reads it, typed and lent values aside. A chat
 *  weight is the onboarding's answer only then (US-62 AC31a). */
export function weightStepOpen(saved: ReadonlyArray<Pick<ApiMeasurement, 'metricType' | 'value'>>): boolean {
  return !plausible(mergeLongitudinalInputs({}, saved).weightKg, UNIT_DEFS.weight.validationRange.si);
}

/** What a record holds beyond its profile, as `opensFullForm` reads it. */
export interface RecordHoldings {
  saved: ReadonlyArray<Pick<ApiMeasurement, 'metricType'>>;
  medications?: ReadonlyArray<unknown>;
  screenings?: ReadonlyArray<unknown>;
  supplements?: ReadonlyArray<unknown>;
  documents?: ReadonlyArray<unknown>;
  labValues?: ReadonlyArray<unknown>;
}

/** The whole form shows once the onboarding is done, or at once for a record
 *  holding more than the onboarding's answers: any saved value but the
 *  weight (a blood test, a waist, a blood pressure), a medication,
 *  screening, supplement, lab test or document. The missing questions are
 *  pinned at the top (US-01 AC3). */
export function opensFullForm(stage: FormStage, record: RecordHoldings): boolean {
  const { saved, ...lists } = record;
  return stage === 4 || saved.some(m => m.metricType !== 'weight') || Object.values(lists).some(list => (list?.length ?? 0) > 0);
}
