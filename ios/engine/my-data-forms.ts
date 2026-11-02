// The My data tab's medications, screenings, supplements and value history
// (US-25 AC8, AC9). Every question, option and hint is health-core's
// input-form.ts, the web form's own; every write is the web's own function
// (setScreening, upsertMedication, upsertSupplement) behind the API's own
// schema. Swift renders what comes out and sends answers back; it decides
// nothing clinical.
import type { RoadmapFile } from '../../packages/health-core/src/roadmap-file';
import { computePlan, derivePlanInputs, type Plan } from '../../packages/health-core/src/plan';
import {
  SUPPLEMENT_DOSE_UNITS, SUPPLEMENT_TEXT, medicationForm, medicationWrites, screeningForm,
  screeningMonths, screeningWrites, type FormField, type FormSection,
} from '../../packages/health-core/src/input-form';
import { lipidMarkerFor, medicinesShown, weightMedicationTrigger } from '../../packages/health-core/src/suggestions';
import { SUPPLEMENT_OPTIONS, type HealthInputs } from '../../packages/health-core/src/types';
import { SCREENING_KEYS, screeningSchema } from '../../packages/health-core/src/validation';
import { setScreening } from '../../packages/health-core/src/state-edits';
import { localDay } from '../../packages/health-core/src/merge';
import { METRIC_LABELS, METRIC_TO_FIELD } from '../../packages/health-core/src/mappings';
import { latestActivePerMetric } from '../../packages/health-core/src/measurement-history';
import type { MetricType } from '../../packages/health-core/src/units';
import { BLOOD_PRESSURE, pressureHistory } from './blood-pressure';
import { cellUnitFor, systemFor, type UnitChoices } from './unit-choices';
import type { EditOutcome } from './my-data';
import { cellLabel, cellText } from '../../packages/health-core/src/cell-unit';
import { medicationAnnotations, medicationChanges } from '../../packages/health-core/src/medication-annotations';

/** A supplement as the tab lists it. */
export interface SupplementRow {
  key: string;
  name: string;
  dose: number | null;
  unit: string | null;
  /** YYYY-MM-DD */
  startedDay: string;
}

export interface SupplementsView {
  intro: string;
  active: SupplementRow[];
  /** Stopped ones, newest change first, so one can be taken again in a tap. */
  stopped: SupplementRow[];
  /** The catalogue not already taken: featured first (the web's quick-add chips), then the rest. */
  choices: Array<{ key: string; name: string; featured: boolean; dose: number | null; unit: string | null }>;
  units: string[];
}

export interface FormsView {
  medications: FormSection[];
  screenings: FormSection[];
  /** Why there are no screening questions, in plain words; null when there are. */
  screeningNote: string | null;
  supplements: SupplementsView;
  /** The months a past or future screening date may name, YYYY-MM, oldest first. */
  months: { past: string[]; future: string[] };
}

/** One row of a metric's history, newest first. */
export interface HistoryRow {
  id: string;
  value: string;
  /** YYYY-MM-DD */
  day: string;
  status: 'active' | 'entered-in-error';
  /** The value the plan uses now. */
  current: boolean;
  /** This row corrected an earlier one. */
  correction: boolean;
  /** A blood pressure's halves, a dash's place null (blood-pressure.ts). */
  systolic?: string | null;
  diastolic?: string | null;
  /** A blood pressure's active row ids, which a replace sends back as `seenIds`. */
  pairIds?: string[];
}

export interface MetricHistory {
  metric: string; label: string; unit: string; rows: HistoryRow[];
  /** The plan set the current value aside (outside the range it accepts), so it is not used (Codex R2). */
  excluded: boolean;
  /** The recorded medication changes this metric's chart marks, oldest first, as the web's
   *  chart does (health-core's medicationAnnotations). `metricHistory` always sends it. */
  markers: MedicationMarker[];
}

/** One recorded medication change on a metric page. */
export interface MedicationMarker {
  id: string;
  /** YYYY-MM-DD: the phone's own day of the recorded time, as the web plots it in the reader's. */
  day: string;
  /** "Recorded start: Atorvastatin 20mg" */
  label: string;
}

/** The edits this file answers; my-data.ts's `Edit` includes them. */
export type FormEdit =
  /** One answer to a medication question (`field` is a key of `medications`). */
  | { kind: 'medicationField'; field: string; value: string }
  /** One screening answer; '' clears it. */
  | { kind: 'screening'; key: string; value: string }
  /** A supplement typed by name, not on the list. */
  | { kind: 'customSupplement'; name: string };

/** The record's plan for `now` and `choices`; null when it cannot be made (no usable height; US-07 AC8). */
export function planOf(file: RoadmapFile, now: string, choices: UnitChoices): Plan | null {
  try {
    return computePlan(file, new Date(now), choices);
  } catch {
    return null;
  }
}

/** What the medication and screening questions read: the plan's age, BMI, trigger and lipid marker, as the web's PlanBasis.
 *  `plan`: the record's plan (`planOf`); null gives no age and no cascades (the web's planBasis null). */
function basisOf(file: RoadmapFile, choices: UnitChoices, plan: Plan | null) {
  const derived = derivePlanInputs(file);
  const raw = derived.inputs;
  const hasLipidInput = raw.apoB !== undefined || raw.ldlC !== undefined || raw.totalCholesterol !== undefined || raw.hdlC !== undefined;
  const hasWeightInput = raw.hba1c !== undefined || raw.triglycerides !== undefined || (raw.weightKg !== undefined && raw.heightCm !== undefined);
  const results = plan?.results;
  const medicines = !!results && medicinesShown(results);
  return {
    derived, age: results?.age, sex: raw.sex,
    medication: {
      lipidMarker: medicines ? lipidMarkerFor(plan!.inputs as HealthInputs, results!) : null,
      weightMedTrigger: medicines ? weightMedicationTrigger(plan!.inputs as HealthInputs, results!) : { on: false, reasons: [] },
      bmi: results?.bmi,
      hasLipidInput,
      hasWeightInput,
      unitFor: (metric: MetricType) => systemFor(file, metric, choices),
    },
  };
}

/**
 * A supplement row as the tab lists it. The migration keeps rows in odd
 * shapes (hand edits, other writers), so each field is read defensively:
 * one odd row must never lock the tab.
 */
function supplementRow(row: RoadmapFile['supplements'][number]): SupplementRow {
  const text = (value: unknown) => (typeof value === 'string' ? value : null);
  return {
    key: row.supplementKey, name: row.supplementName,
    dose: typeof row.doseValue === 'number' && Number.isFinite(row.doseValue) ? row.doseValue : null,
    unit: text(row.doseUnit), startedDay: (text(row.startedAt) ?? '').slice(0, 10),
  };
}

/** Supplements with a usable key and name, as medicationsToInputs skips a nameless medication. */
function listable(file: RoadmapFile, status: 'active' | 'stopped') {
  return file.supplements.filter((s) => s.status === status && typeof s.supplementKey === 'string' && typeof s.supplementName === 'string');
}

/**
 * The questions for this record. A record these cannot be built from (an odd
 * row this code did not foresee) gets no questions and a plain note, so the
 * rest of My data still opens and saves (adversary R2).
 */
export function formsOf(file: RoadmapFile, now: string, choices: UnitChoices, plan: Plan | null): FormsView {
  return formsAndBasis(file, now, choices, plan).forms;
}

/** The forms, and the basis they were built on (null when they could not be): an
 *  answer is checked against the forms and written from the same basis, so the plan
 *  behind them is computed once per call. */
function formsAndBasis(file: RoadmapFile, now: string, choices: UnitChoices, plan: Plan | null): { forms: FormsView; basis: Basis | null } {
  try {
    const basis = basisOf(file, choices, plan);
    return { forms: buildForms(file, now, basis), basis };
  } catch {
    return {
      forms: {
        medications: [], screenings: [],
        screeningNote: 'Your medication, screening and supplement answers could not be read from this record.',
        supplements: { intro: SUPPLEMENT_TEXT.intro, active: [], stopped: [], choices: [], units: [...SUPPLEMENT_DOSE_UNITS] },
        months: { past: [], future: [] },
      },
      basis: null,
    };
  }
}

type Basis = ReturnType<typeof basisOf>;

function buildForms(file: RoadmapFile, now: string, basis: Basis): FormsView {
  const screenings = screeningForm(basis.age, basis.sex, basis.derived.screenings);
  const taking = new Set(file.supplements.filter((s) => s.status === 'active').map((s) => s.supplementKey));
  const featuredFirst = [...SUPPLEMENT_OPTIONS].sort((a, b) => Number(b.category === 'featured') - Number(a.category === 'featured'));
  const today = localDay(new Date(now));
  return {
    medications: medicationForm(basis.derived.medications, basis.medication),
    screenings,
    screeningNote: screenings.length > 0 ? null
      : basis.age === undefined ? 'Screening questions appear once your sex, birth year and height are in About you.'
        // US-07 AC8: with no sex, the sexed questions wait for it; "at your age and sex" would be wrong.
        : basis.sex === undefined ? 'Some screening questions depend on your sex. Add it in About you.'
          : 'No screening questions apply at your age and sex yet.',
    supplements: {
      intro: SUPPLEMENT_TEXT.intro,
      active: listable(file, 'active').map(supplementRow),
      stopped: listable(file, 'stopped').sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? ''))).map(supplementRow),
      choices: featuredFirst.filter((o) => !taking.has(o.key)).map((o) => ({
        key: o.key, name: o.name, featured: o.category === 'featured', dose: o.defaultDose ?? null, unit: o.defaultUnit ?? null,
      })),
      units: [...SUPPLEMENT_DOSE_UNITS],
    },
    months: { past: screeningMonths('past', today), future: screeningMonths('future', today) },
  };
}

/** Every field of a form, by key. */
function fieldsByKey(sections: FormSection[]): Map<string, FormField> {
  const map = new Map<string, FormField>();
  for (const field of sections.flatMap((s) => s.groups.flatMap((g) => g.fields))) if ('key' in field) map.set(field.key, field);
  return map;
}

/** An answer the question offers: a pickable option, a month in its range, or a whole number in its range. */
function offered(field: FormField, value: string, months: FormsView['months']): boolean {
  switch (field.kind) {
    case 'choice': return field.options.some((o) => o.value === value && !o.disabled);
    case 'month': return value === '' || months[field.when].includes(value);
    case 'number': {
      if (value === '') return true;
      const n = Number(value);
      return /^\d+$/.test(value) && n >= field.min && n <= field.max;
    }
    default: return false;
  }
}

type Outcome = { ok: true; file: RoadmapFile } | Extract<EditOutcome, { ok: false }>;
type Save = (file: RoadmapFile, edit: { kind: 'medication'; medicationKey: string; drugName: string; doseValue: number | null; doseUnit: string | null }) => Outcome;

/**
 * One form answer. Only a question the form shows now can be answered, and
 * only with an answer it offers, so the app can write nothing the web form
 * could not. The answer's dependent writes follow, as on the web.
 */
export function applyFormEdit(file: RoadmapFile, edit: Exclude<FormEdit, { kind: 'customSupplement' }>, now: string, saveMedication: Save): Outcome {
  const { forms, basis } = formsAndBasis(file, now, {}, planOf(file, now, {}));
  if (edit.kind === 'medicationField') {
    const field = fieldsByKey(forms.medications).get(edit.field);
    // No basis, no forms: every answer is refused here.
    if (!basis || !field || !offered(field, edit.value, forms.months)) {
      return { ok: false, reason: 'invalid-value', message: 'That is not an answer this question offers.' };
    }
    // The web resets an escalation answer only while that drug's cascade runs (US-06 AC7).
    const { medication } = basis;
    const weightField = ['glp1', 'glp1_dose', 'glp1_escalation', 'sglt2i', 'sglt2i_dose', 'metformin'].includes(edit.field);
    const cascadeMode = weightField ? medication.weightMedTrigger.on : !!medication.lipidMarker?.elevated;
    let next = file;
    for (const save of medicationWrites(basis.derived.medications, cascadeMode, edit.field, edit.value)) {
      const outcome = saveMedication(next, { kind: 'medication', ...save });
      if (!outcome.ok) return outcome;
      next = outcome.file;
    }
    return { ok: true, file: next };
  }
  // A screening answer, behind the API's own key check.
  if (!(SCREENING_KEYS as readonly string[]).includes(edit.key)) {
    return { ok: false, reason: 'invalid-value', message: 'There is no such screening question.' };
  }
  if (edit.value !== '' && !screeningSchema.safeParse({ screeningKey: edit.key, value: edit.value }).success) {
    return { ok: false, reason: 'invalid-value', message: 'That is not a screening answer.' };
  }
  const field = fieldsByKey(forms.screenings).get(edit.key);
  if (!basis || !field || !offered(field, edit.value, forms.months)) {
    return { ok: false, reason: 'invalid-value', message: 'That is not an answer this question offers.' };
  }
  const writes = screeningWrites(basis.derived.screenings, edit.key, edit.value);
  return { ok: true, file: writes.reduce((next, [key, value]) => setScreening(next, key, value, now), file) };
}

/**
 * Every value recorded for a metric, newest day first, entered-in-error rows
 * included (the app strikes them through). The record is append-only: this
 * view offers corrections, never removal.
 */
export function metricHistory(file: RoadmapFile, metric: string, now = new Date().toISOString(), choices: UnitChoices = {}): MetricHistory {
  // No plan yet (no usable height): nothing is excluded, and nothing used.
  const excludedFields = planOf(file, now, {})?.excluded ?? [];
  // The web's own pins (US-25 AC9b): none for a metric no medication affects.
  const markers = (medicationAnnotations(medicationChanges(file.medicationHistory))[metric] ?? [])
    .map(({ id, date, label }) => ({ id, day: localDay(new Date(date)), label }));
  if (metric === BLOOD_PRESSURE) return { ...pressureHistory(file, excludedFields), markers };
  const shown = cellUnitFor(file, metric, choices);
  const rows = file.measurements.filter((row) => row.metricType === metric);
  // The plan's own pick of the current value.
  const current = latestActivePerMetric(rows.filter((row) => row.status === 'active'))[0];
  return {
    metric,
    excluded: excludedFields.includes(METRIC_TO_FIELD[metric]),
    label: METRIC_LABELS[metric] ?? metric,
    unit: cellLabel(metric as MetricType, shown),
    markers,
    rows: [...rows]
      // Newest day first; within a day, newest written first, the active row above the ones it replaced.
      .sort((a, b) => b.recordedAt.slice(0, 10).localeCompare(a.recordedAt.slice(0, 10)) || String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''))
        || Number(b.status === 'active') - Number(a.status === 'active'))
      .map((row) => ({
        id: row.id,
        value: cellText(metric as MetricType, row.value, shown),
        day: row.recordedAt.slice(0, 10),
        status: row.status,
        current: row.id === current?.id,
        // A legacy row may lack the key: only a named row is a correction.
        correction: !!row.correctsId,
      })),
  };
}
