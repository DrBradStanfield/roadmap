// The My data tab's medications, screenings, supplements and value history
// (US-25 AC8, AC9). Every question, option and hint is health-core's
// input-form.ts, the web form's own; every write is the web's own function
// (setScreening, upsertMedication, upsertSupplement) behind the API's own
// schema. Swift renders what comes out and sends answers back; it decides
// nothing clinical.
import { CORE_BLOOD_UNITS, type RoadmapFile } from '../../packages/health-core/src/roadmap-file';
import { isCoreRow } from '../../packages/health-core/src/blood-tests';
import { computePlan, derivePlanInputs, egfrSeries, whtrSeries, type Plan } from '../../packages/health-core/src/plan';
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
import { isVersionMarker } from '../../packages/health-core/src/health-records-import';
import { WHTR_TARGET, type MetricType } from '../../packages/health-core/src/units';
import { BLOOD_PRESSURE, pressureHistory } from './blood-pressure';
import { cellUnitFor, systemFor, type UnitChoices } from './unit-choices';
import type { EditOutcome } from './my-data';
import { cellFromSI, cellLabel, limitCellText, type CellUnit } from '../../packages/health-core/src/cell-unit';
import { LIMIT_NOT_GRADED, comparatorOf, formatGradedOrLimit, isComparator, type Comparator } from '../../packages/health-core/src/lab-limits';
import { groupLabValues, labValueLabel, mixedUnitsNote, savedLabText } from '../../packages/health-core/src/lab-series';
import { displayLabUnit, labSlotKey, resolveLabCatalogEntry } from '../../packages/health-core/src/lab-catalog';
import { limitUngraded, pressureStatus, valueStatus, type GradeContext, type PressureReading } from '../../packages/health-core/src/row-grade';
import { knownMinorOf } from '../../packages/health-core/src/calculations';
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
  /** A lab result printed as a limit (US-12 AC20): its bound in the row's unit, where the
   *  chart plots it, hollow and out of the line. `value` then reads "> 60". Absent otherwise. */
  bound?: number;
  /** The plan's word on the current value when it says more than "used": a limit it cannot grade. */
  note?: string;
  /** A lab test's row: the unit it was reported in, as displayed (US-25 AC25). */
  unit?: string;
  /** A lab test's exact value, unrounded, for the chart (`value` is for reading). */
  number?: number;
  /** An eGFR row's: the lab printed it, or the app worked it out from that day's creatinine (US-73 AC7). */
  source?: 'lab' | 'calculated';
}

export interface MetricHistory {
  metric: string; label: string; unit: string; rows: HistoryRow[];
  /** The plan set the current value aside (outside the range it accepts), so it is not used (Codex R2). */
  excluded: boolean;
  /** The recorded medication changes this metric's chart marks, oldest first, as the web's
   *  chart does (health-core's medicationAnnotations). `metricHistory` always sends it. */
  markers: MedicationMarker[];
  /** A lab test reported in more than one unit: why the page draws no chart, in the web's words
   *  (`mixedUnitsNote`, US-21 AC3a). Absent otherwise. */
  unitsNote?: string;
  /** A worked-out series' target, as a row prints it under the name: waist-to-height's "Normal <0.5". */
  target?: string;
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
 * included (the app strikes them through), Health Records version markers left
 * out (US-72 AC5). The record is append-only: this
 * view offers corrections, never removal.
 */
/** A stored value as its cell shows it: a limit with its symbol, at places that keep it true (US-12 AC20).
 *  A raised PSA prints on its side of 4.0, as the web's PSA line does (US-06 AC18). */
export function rowText(metric: MetricType, row: { value: number; comparator?: Comparator }, unit: CellUnit): string {
  const { comparator } = comparatorOf(row);
  return metric === 'psa' ? formatGradedOrLimit('psa', row.value, 'si', comparator) : limitCellText(metric, row.value, unit, comparator);
}

/** Whom and against what plan My data's values are graded, as the web's rows grade them (InputPanel.tsx
 *  rowCtx): no adult lines for a known minor (US-07 AC6), and the plan's age, weight target and height. */
export function gradeContextOf(file: RoadmapFile, now: string, plan: Plan | null): GradeContext {
  return {
    grading: knownMinorOf(file.profile, new Date(now)) ? null : { sex: file.profile.sex ?? undefined },
    plan: plan && { age: plan.results.age, idealBodyWeight: plan.results.idealBodyWeight, heightCm: plan.results.heightCm },
  };
}

/**
 * A lab test's history (US-25 AC25), as the web's lab value page lists it (ValuePage.tsx): every row
 * of the series (`labSlotKey`), newest day first and, within a day, newest written first, the active
 * row above the ones it replaced. A value printed as a limit reads with its symbol and carries its
 * bound (US-12 AC20). A lab test is never graded, so no row is "used" and none has a limit note.
 * A series whose active rows were reported in more than one unit lists each row's unit (US-21 AC3a).
 */
export function labHistory(file: RoadmapFile, seriesKey: string): MetricHistory {
  // A core row is a core test's, never a lab page's (US-66 AC8).
  const rows = file.labValues.filter((row) => !isCoreRow(row) && labSlotKey(row.metricName) === seriesKey);
  const [series] = groupLabValues(rows).flatMap((group) => group.series);
  const entry = resolveLabCatalogEntry(rows[0]?.metricName ?? seriesKey);
  const unitOf = (row: { unit?: string | null }) => displayLabUnit(row.unit ?? '', entry);
  const listed = [...rows].sort(newestFirst);
  return {
    metric: seriesKey,
    label: series?.label ?? labValueLabel(rows[0]?.metricName ?? seriesKey),
    unit: series?.unit ?? (listed.length ? unitOf(listed[0]) : ''),
    excluded: false,
    markers: [],
    rows: listed.map((row) => {
      const { comparator } = comparatorOf(row);
      return {
        id: row.id,
        value: savedLabText(row.value, comparator),
        day: row.recordedAt.slice(0, 10),
        status: row.status,
        current: false,
        correction: !!row.correctsId,
        unit: unitOf(row),
        // The chart's number, unrounded: the text is for reading (0.001 reads "0").
        ...(comparator ? { bound: row.value } : { number: row.value }),
      };
    }),
    ...(series?.mixedUnits ? { unitsNote: mixedUnitsNote([...new Set(series.points.map((p) => p.unit))]) } : null),
  };
}

/**
 * A worked-out series (US-73 AC7), one row a day, newest first, in a history's shape: `egfr`, the
 * lab's eGFR or ours from the core creatinine (health-core egfrSeries), each row saying which; or
 * `whtr`, each day's waist over the current height (health-core whtrSeries). Read only: a row's
 * id is the series' own (`egfr:<row id>`), so no correction can reach the creatinine or waist
 * behind it; those are corrected on their own pages.
 */
export function derivedHistory(file: RoadmapFile, series: 'egfr' | 'whtr', now: string): MetricHistory {
  const row = (id: string, day: string, value: number, text: string, i: number) => ({
    id: `${series}:${id}`, value: text, day, status: 'active' as const, current: i === 0, correction: false, number: value,
  });
  if (series === 'egfr') {
    const entry = resolveLabCatalogEntry('egfr')!;
    return {
      metric: 'egfr', label: entry.label, unit: entry.unit, excluded: false, markers: [],
      rows: egfrSeries(file, new Date(now)).map((p, i) => ({ ...row(p.id, p.day, p.value, String(p.value), i), source: p.source })),
    };
  }
  return {
    metric: 'whtr', label: 'Waist-to-height', unit: '', excluded: false, markers: [], target: WHTR_TARGET,
    rows: whtrSeries(file).map((p, i) => row(p.id, p.day, p.ratio, p.ratio.toFixed(2), i)),
  };
}

/** A metric's or a lab test's rows as a history lists them: newest day first; within a day,
 *  newest written first, the active row above the ones it replaced. */
function newestFirst(a: { recordedAt: string; createdAt?: string | null; status: string }, b: { recordedAt: string; createdAt?: string | null; status: string }): number {
  return b.recordedAt.slice(0, 10).localeCompare(a.recordedAt.slice(0, 10)) || String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''))
    || Number(b.status === 'active') - Number(a.status === 'active');
}

/** A stored value printed as a limit the shared rule leaves ungraded (`limitUngraded`). */
export function ungradedLimit(metric: MetricType, row: { value: number; comparator?: unknown }, ctx: GradeContext): boolean {
  const { comparator } = comparatorOf(row);
  return limitUngraded(metric, valueStatus(metric, row.value, ctx, comparator), ctx, { value: row.value, comparator });
}

export function metricHistory(file: RoadmapFile, metric: string, now = new Date().toISOString(), choices: UnitChoices = {}): MetricHistory {
  // No plan yet (no usable height): nothing is excluded, and nothing used.
  const plan = planOf(file, now, {});
  const excludedFields = plan?.excluded ?? [];
  // An active value printed as a limit says the plan cannot grade it by the web's rule (US-12 AC20, AC21).
  const ctx = gradeContextOf(file, now, plan);
  // The web's own pins (US-25 AC9b): none for a metric no medication affects.
  const markers = (medicationAnnotations(medicationChanges(file.medicationHistory))[metric] ?? [])
    .map(({ id, date, label }) => ({ id, day: localDay(new Date(date)), label }));
  if (metric === BLOOD_PRESSURE) {
    const pairs = new Map<string, PressureReading>();
    const history = pressureHistory(file, excludedFields, pairs);
    const rows = history.rows.map((row) => {
      const reading = pairs.get(row.id);
      return reading && limitUngraded(BLOOD_PRESSURE, pressureStatus(reading, ctx), ctx, reading) ? { ...row, note: LIMIT_NOT_GRADED } : row;
    });
    return { ...history, rows, markers };
  }
  const shown = cellUnitFor(file, metric, choices);
  // A blood test's rows are its core lab rows in the core unit (US-66 AC7); a vital's, its measurements.
  // A version marker only carries a version the record has seen (US-72 AC5): not a value.
  const rows = [
    ...file.measurements.filter((row) => row.metricType === metric && !(metric in CORE_BLOOD_UNITS)),
    ...file.labValues.filter((row) => isCoreRow(row) && row.metricName === metric && row.unit === CORE_BLOOD_UNITS[metric])
      .map((row) => ({ ...row, metricType: metric })),
  ].filter((row) => !isVersionMarker(row));
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
      .sort(newestFirst)
      .map((row) => ({
        id: row.id,
        value: rowText(metric as MetricType, row, shown),
        day: row.recordedAt.slice(0, 10),
        status: row.status,
        current: row.id === current?.id,
        // A legacy row may lack the key: only a named row is a correction.
        correction: !!row.correctsId,
        ...(isComparator(row.comparator) ? { bound: cellFromSI(metric as MetricType, row.value, shown) } : null),
        ...(row.status === 'active' && ungradedLimit(metric as MetricType, row, ctx) ? { note: LIMIT_NOT_GRADED } : null),
      })),
  };
}
