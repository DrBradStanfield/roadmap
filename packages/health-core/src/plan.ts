/**
 * The plan pipeline: a record file becomes Brad's protocol (US-30, US-32).
 *
 * Lifted out of `tools/get-plan.ts` so the CLI and the MCP tool layer compute
 * ONE plan and cannot drift. Everything here is pure: no `fs`, no argv, no
 * terminal. The CLI keeps reading the file and rendering text and HTML;
 * `renderJson` is the agent-facing shape, and both surfaces return it.
 */
import { calculateHealthResults, missingPlanInputs } from './calculations';
import { fileProfileToApi, fileScreeningRows } from './file-inputs';
import { displayLabUnit, labSlotKey, resolveLabCatalogEntry } from './lab-catalog';
import {
  FIELD_UNITS,
  METRIC_LABELS,
  METRIC_TO_FIELD,
  measurementsToInputs,
  medicationsToInputs,
  screeningsToInputs,
  withPsaMeasurement,
  type ApiMeasurement,
} from './mappings';
import { latestActivePerMetric } from './measurement-history';
import { cmpStr, dayOf, localDay } from './merge';
import { refLineFor } from './reference-hints';
import { computeReminderSchedule, type ReminderScheduleItem } from './reminder-schedule';
import { BASE_SCHEMA_VERSION, type FileLabValue, type RoadmapFile } from './roadmap-file';
import type { HealthInputs, HealthResults, MedicationInputs, ScreeningInputs } from './types';
import {
  UNIT_DEFS, formatDisplayValue, formatGradedValue, getDisplayLabel, type MetricType, type UnitSystem,
} from './units';
import { getValidationErrors, PRESSURE_ORDER, sanitizeInputs, validateHealthInputs } from './validation';

/** This project, named once. Every URL that points at the code derives from it. */
export const REPO_SLUG = 'DrBradStanfield/roadmap';

/** Where an assistant reads the code, and where report_feedback files an issue. */
export const REPO_URL = `https://github.com/${REPO_SLUG}`;

/**
 * Whether the repository is public, so agent-facing text may link to it.
 * GitHub flagged the account on 2026-09-18 and the repository answered 404 to
 * everyone but its owner; the flag lifted and the repository was public again
 * on 2026-10-12. It stays a kill switch: if the repository goes dark again,
 * set this false and every agent surface stops naming a URL a reviewer would
 * meet as a 404 (US-32 AC39). Both settings are tested.
 */
export const REPO_PUBLIC = true;

export const SCHEMA_URL =
  `https://raw.githubusercontent.com/${REPO_SLUG}/main/docs/health-roadmap-file.schema.json`;

/**
 * What a model presenting this plan must not do: sand the hedging off a
 * suggestion, or show it without the citation it rests on; for a known minor,
 * grade their values or suggest medicines (US-07 AC6). It is stated in the
 * payload because the payload is all a remote model gets (US-32).
 */
export const PLAN_INSTRUCTION =
  'Present this plan in your own words if you like, but keep it faithful: each suggestion’s hedged wording ' +
  '("may support", "evidence suggests") is calibrated — never upgrade it into a recommendation — and every ' +
  'reference stays attached to the suggestion it belongs to. This is educational, not medical advice: say so, and ' +
  'tell the user to take it to their doctor. When the plan holds only the `adults-only` card, do not grade the ' +
  'person’s values against adult targets and do not suggest medicines; point them to their doctor.';

/** A failure the user can act on: one plain line plus a hint, never a stack. */
export class PlanError extends Error {
  constructor(message: string, readonly hint: string) {
    super(message);
    this.name = 'PlanError';
  }
}

/**
 * Text out of the record, made safe to print: a name lifted off an uploaded PDF
 * can carry terminal control codes (cursor moves, screen clears, BEL), and the
 * record is data — it must never drive the terminal. Newlines survive.
 */
export function printable(text: string): string {
  return text.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, '');
}

/**
 * Anything lifted out of the record — a test name, a unit, a row id — goes
 * through here before it is interpolated. `printable` strips the control codes
 * an uploaded PDF can carry; the newlines it leaves would otherwise forge a
 * whole line that reads as the tool's own, so they go too. The CLI needs this
 * for a terminal and the MCP tools need it for a model's context (US-32).
 */
export function oneLine(text: string): string {
  return printable(text).replace(/[\n\u2028\u2029]+/g, ' ');
}

// ---------------------------------------------------------------------------
// Derive — the same path the widget takes (US-30 AC2)
// ---------------------------------------------------------------------------

export interface PlanInputs {
  inputs: Partial<HealthInputs>;
  unitSystem: UnitSystem;
  medications: MedicationInputs;
  screenings: ScreeningInputs;
  /**
   * The winning row per metric, with its clinical date. A row whose value the
   * schema rejects is still here — the file says it, so the report shows it —
   * but `Plan.excluded` names those fields and the plan did not use them.
   */
  currentRows: ApiMeasurement[];
}

/**
 * File → inputs, exactly as the widget derives them: the newest active row per
 * metric (US-07 AC4) mapped through `measurementsToInputs` over the file's
 * profile, medications and screenings converted by health-core. Per-field
 * display-unit overrides are deliberately absent — those live in the browser's
 * localStorage, never in the record, so the CLI renders in `profile.unitSystem`.
 */
export function derivePlanInputs(file: RoadmapFile, now = new Date()): PlanInputs {
  const active = file.measurements.filter((m) => m.status === 'active') as ApiMeasurement[];
  const currentRows = latestActivePerMetric(active);
  const creatinine = currentRows.find((r) => r.metricType === 'creatinine');
  return {
    inputs: withLabEgfr(
      measurementsToInputs(currentRows, fileProfileToApi(file.profile)),
      creatinine ? dayOf(creatinine.recordedAt) : null, labEgfrOf(file.labValues), localDay(now),
    ),
    unitSystem: file.profile.unitSystem ?? 'si',
    medications: medicationsToInputs(file.medications),
    screenings: screeningsToInputs(fileScreeningRows(file.screenings)),
    currentRows,
  };
}

/** A lab row as `labEgfrOf` reads it: the file's rows and the widget's both fit. */
type LabRowLike = Pick<FileLabValue, 'id' | 'metricName' | 'value' | 'unit' | 'recordedAt'> & { createdAt?: string; status?: string };

/** The lab's printed creatinine eGFR and its day: one candidate for the plan's eGFR (US-07 AC7). */
export type LabEgfr = Required<Pick<HealthInputs, 'labEgfr' | 'labEgfrDate'>>;

/**
 * US-07 AC7: the latest active lab `egfr` row (the creatinine eGFR: never
 * cystatin C or combined), in the catalogue's unit and the schema's range;
 * null when there is none.
 */
export function labEgfrOf(labValues: readonly LabRowLike[]): LabEgfr | null {
  const rows = labValues.filter((l) => labSlotKey(l.metricName) === 'egfr'
    && l.unit === resolveLabCatalogEntry(l.metricName)?.unit && 'labEgfr' in sanitizeInputs({ labEgfr: l.value }));
  const lab = latestActivePerMetric(rows.map((l) => ({ ...l, metricType: 'egfr' })))[0];
  return lab ? { labEgfr: lab.value, labEgfrDate: dayOf(lab.recordedAt) } : null;
}

/**
 * US-07 AC7 (Brad 2026-10-27): the inputs with the lab's printed eGFR set when
 * it is the plan's eGFR, and cleared when it is not. The candidates are `lab`
 * (labEgfrOf) and the eGFR calculated from the creatinine the inputs hold,
 * dated `creatinineDay`. Only an eGFR the plan can calculate competes: a
 * creatinine the schema keeps, and a birth year. The newer by day wins; on
 * the same day the lab's does, since ours may come from a misread creatinine.
 * A creatinine with no date (typed, not yet saved: `null`) is `today`'s, the
 * day it would be saved with.
 */
export function withLabEgfr<T extends Partial<HealthInputs>>(
  inputs: T, creatinineDay: string | null, lab: LabEgfr | null, today: string,
): T {
  const { labEgfr: _value, labEgfrDate: _day, ...rest } = inputs;
  if (!lab) return rest as T;
  const usable = sanitizeInputs({ creatinine: inputs.creatinine, birthYear: inputs.birthYear });
  const crDay = usable.creatinine === undefined || usable.birthYear === undefined ? null : creatinineDay ?? today;
  return crDay !== null && crDay > lab.labEgfrDate ? rest as T : { ...rest, ...lab } as T;
}

export interface PlanLab {
  /** The row id — what `edit-record.ts correct --id` takes. */
  id: string;
  key: string;
  label: string;
  value: number;
  unit: string;
  date: string;
}

/** Latest active row per lab test, named and unit-labelled from the catalogue. */
function derivePlanLabs(file: RoadmapFile): PlanLab[] {
  const active = file.labValues.filter((l) => l.status === 'active');
  const rows = latestActivePerMetric(active.map((l) => ({ ...l, metricType: labSlotKey(l.metricName) }))) as FileLabValue[];
  return rows
    .map((l) => {
      const entry = resolveLabCatalogEntry(l.metricName);
      return {
        id: l.id,
        key: labSlotKey(l.metricName),
        label: entry?.label ?? l.metricName,
        value: l.value,
        unit: displayLabUnit(l.unit, entry),
        date: String(l.recordedAt ?? '').slice(0, 10),
      };
    })
    .sort((a, b) => cmpStr(a.label, b.label));
}

export interface Plan extends PlanInputs {
  generatedAt: string;
  /** The user's local calendar day at `generatedAt` — the plan's ONE "today". */
  today: string;
  results: HealthResults;
  due: ReminderScheduleItem[];
  labs: PlanLab[];
  /** Input fields dropped as out of range — displayed, never fed to the plan. */
  excluded: string[];
  /** The blood pressure is in `excluded` because the day's pair is the wrong way up (US-02 AC8), not out of range. */
  pressureOrder?: boolean;
}

/** Why a row the plan left out was left out, when it is not out of range (US-02 AC8). */
export const PRESSURE_EXCLUDED = 'the top number is not above the bottom one, so the plan ignores this day’s blood pressure';

/**
 * The whole plan. Invalid fields are stripped before calculating (the widget
 * does the same), so one bad number costs its own suggestion, not the report.
 * `unitOverrides`: per-metric display units, the web's per-field toggles (US-05), so a
 * target reads in the unit the person chose for that test; absent, `unitSystem` throughout.
 */
export function computePlan(file: RoadmapFile, now = new Date(), unitOverrides?: Partial<Record<MetricType, UnitSystem>>): Plan {
  const derived = derivePlanInputs(file, now);
  let inputs = derived.inputs;
  let excluded: string[] = [];
  const day = (metric: string) => {
    const row = derived.currentRows.find((r) => r.metricType === metric);
    return row ? dayOf(row.recordedAt) : null;
  };

  const validation = validateHealthInputs(inputs, { systolicBp: day('systolic_bp'), diastolicBp: day('diastolic_bp') }, now);
  if (!validation.success && validation.errors) {
    const invalid = new Set(validation.errors.issues.map((i) => String(i.path[0])));
    if (invalid.has('heightCm') || invalid.has('sex')) {
      throw new PlanError(
        `This record has no usable height and sex (${Object.values(getValidationErrors(validation.errors)).join('; ')})`,
        'The plan needs both. Ask the user for their height, and whether the plan should be computed for male or ' +
          'female, and set them on the record — with `update_profile` if you have it, otherwise in the app — then ' +
          'run this again.',
      );
    }
    const stripped = { ...inputs } as Record<string, unknown>;
    for (const field of invalid) stripped[field] = undefined;
    inputs = stripped as Partial<HealthInputs>;
    excluded = [...invalid];
  }
  return {
    ...derived,
    inputs,
    excluded,
    ...(validation.errors?.issues.some((i) => i.message === PRESSURE_ORDER) ? { pressureOrder: true } : {}),
    generatedAt: now.toISOString(),
    today: localDay(now),
    // US-06 AC14: the prostate cards read the newest saved PSA; `screenings` above stays the record's answers.
    results: calculateHealthResults(inputs as HealthInputs, derived.unitSystem, derived.medications,
      withPsaMeasurement(derived.screenings, derived.currentRows.find((r) => r.metricType === 'psa')),
      unitOverrides, now),
    due: computeReminderSchedule(file, now),
    labs: derivePlanLabs(file),
  };
}

// ---------------------------------------------------------------------------
// Shared shaping — the rows every renderer prints
// ---------------------------------------------------------------------------

/** A printed row: current value or lab. `excluded` marks a value the plan ignored; `excludedReason` says why when it is not out of range. */
export type DisplayRow = { id: string; label: string; value: unknown; unit: string; date: string; excluded?: boolean; excludedReason?: string };

/**
 * Current values as displayed: row id, label, converted value, unit, clinical
 * date. The id is here because `correct --id` needs one and this is the only
 * place a reader is told to look for it.
 * A value the schema rejected is marked `excluded` — it is in the file, so it
 * is on the report, but the reader must not mistake it for a plan input.
 */
export function currentValues(plan: Plan) {
  const excluded = new Set(plan.excluded);
  return plan.currentRows
    .filter((row) => row.metricType in UNIT_DEFS)
    .map((row) => {
      const metric = row.metricType as MetricType;
      // A lipid with a "<X" line prints on the side the cards grade it (US-07 AC5).
      const line = refLineFor(metric);
      return {
        id: row.id,
        metric: row.metricType,
        label: METRIC_LABELS[row.metricType] ?? row.metricType,
        value: line === undefined
          ? formatDisplayValue(metric, row.value, plan.unitSystem)
          : formatGradedValue(metric, row.value, plan.unitSystem, line),
        unit: getDisplayLabel(metric, plan.unitSystem),
        date: String(row.recordedAt ?? '').slice(0, 10),
        excluded: excluded.has(METRIC_TO_FIELD[row.metricType]) || undefined,
        excludedReason: plan.pressureOrder && row.metricType.endsWith('_bp') ? PRESSURE_EXCLUDED : undefined,
      };
    })
    .sort((a, b) => cmpStr(a.label, b.label));
}

export function dueSplit(plan: Plan): { overdue: ReminderScheduleItem[]; upcoming: ReminderScheduleItem[] } {
  const sorted = [...plan.due].sort((a, b) => cmpStr(a.dueAt, b.dueAt));
  return {
    overdue: sorted.filter((i) => i.dueAt <= plan.today),
    upcoming: sorted.filter((i) => i.dueAt > plan.today),
  };
}

/** The agent-facing shape. Field names are stable; add, never rename. */
export function planPayload(plan: Plan) {
  const { overdue, upcoming } = dueSplit(plan);
  // US-07 AC6: a known minor's raw values stay; the adult readings are null.
  const adult = plan.results.knownMinor ? null : plan.results;
  return {
    instruction: PLAN_INSTRUCTION,
    schemaVersion: BASE_SCHEMA_VERSION,
    generatedAt: plan.generatedAt,
    today: plan.today,
    unitSystem: plan.unitSystem,
    units: FIELD_UNITS,
    profile: {
      sex: plan.inputs.sex,
      age: plan.results.age ?? null,
      heightCm: plan.results.heightCm,
      bmi: plan.results.bmi ?? null,
      bmiCategory: adult?.bmiCategory ?? null,
      waistToHeightRatio: plan.results.waistToHeightRatio ?? null,
      eGFR: adult?.eGFR ?? null,
      idealBodyWeightKg: adult?.idealBodyWeight ?? null,
      proteinTargetG: adult?.proteinTarget ?? null,
    },
    inputs: plan.inputs,
    missingInputs: missingPlanInputs(plan.inputs),
    currentValues: currentValues(plan),
    labValues: plan.labs,
    medications: plan.medications,
    screenings: plan.screenings,
    due: { overdue, upcoming },
    suggestions: plan.results.suggestions.map((s) => ({
      id: s.id,
      category: s.category,
      priority: s.priority,
      title: s.title,
      description: s.description,
      ingredients: s.ingredients ?? [],
      // No `link`: on the widget it is a product link (an affiliate short link,
      // a brand's shop), and a plugin must not serve ads (US-32 AC39). Evidence
      // lives in `references` and `guidelines`, never in `link`.
      reason: s.reason ?? null,
      guidelines: s.guidelines ?? [],
      references: s.references ?? [],
    })),
    // `repo` makes the two paths resolvable: without it an assistant is holding
    // file names it cannot open, so they go too while the repository 404s (AC39, AC41).
    source: REPO_PUBLIC
      ? { repo: REPO_URL, schema: SCHEMA_URL, tool: 'tools/get-plan.ts', docs: 'docs/agent-access.md' }
      : { repo: null, schema: null },
  };
}

/** The same shape, serialized — what a CLI prints and a tool puts in `content`. */
export function renderJson(plan: Plan): string {
  return JSON.stringify(planPayload(plan), null, 2);
}
