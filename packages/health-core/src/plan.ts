/**
 * The plan pipeline: a record file becomes Brad's protocol (US-30, US-32).
 *
 * Lifted out of `tools/get-plan.ts` so the CLI and the MCP tool layer compute
 * ONE plan and cannot drift. Everything here is pure: no `fs`, no argv, no
 * terminal. The CLI keeps reading the file and rendering text and HTML;
 * `renderJson` is the agent-facing shape, and both surfaces return it.
 */
import { calculateHealthResults } from './calculations';
import { fileProfileToApi, fileScreeningRows } from './file-inputs';
import { displayLabUnit, labSlotKey, resolveLabCatalogEntry } from './lab-catalog';
import {
  METRIC_LABELS,
  METRIC_TO_FIELD,
  measurementsToInputs,
  medicationsToInputs,
  screeningsToInputs,
  type ApiMeasurement,
} from './mappings';
import { latestActivePerMetric } from './measurement-history';
import { cmpStr, localDay } from './merge';
import { computeReminderSchedule, type ReminderScheduleItem } from './reminder-schedule';
import { CURRENT_SCHEMA_VERSION, type FileLabValue, type RoadmapFile } from './roadmap-file';
import type { HealthInputs, HealthResults, MedicationInputs, ScreeningInputs } from './types';
import { UNIT_DEFS, formatDisplayValue, getDisplayLabel, type MetricType, type UnitSystem } from './units';
import { getValidationErrors, validateHealthInputs } from './validation';

export const SCHEMA_URL =
  'https://raw.githubusercontent.com/DrBradStanfield/roadmap/main/docs/health-roadmap-file.schema.json';

/**
 * What a model presenting this plan must not do: sand the hedging off a
 * suggestion, or show it without the citation it rests on. It is stated in the
 * payload because the payload is all a remote model gets (US-32).
 */
export const PLAN_INSTRUCTION =
  'Present this plan in your own words if you like, but keep it faithful: each suggestion’s hedged wording ' +
  '("may support", "evidence suggests") is calibrated — never upgrade it into a recommendation — and every ' +
  'reference stays attached to the suggestion it belongs to. This is educational, not medical advice: say so, and ' +
  'tell the user to take it to their doctor.';

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
export function derivePlanInputs(file: RoadmapFile): PlanInputs {
  const active = file.measurements.filter((m) => m.status === 'active') as ApiMeasurement[];
  const currentRows = latestActivePerMetric(active);
  return {
    inputs: measurementsToInputs(currentRows, fileProfileToApi(file.profile)),
    unitSystem: file.profile.unitSystem ?? 'si',
    medications: medicationsToInputs(file.medications),
    screenings: screeningsToInputs(fileScreeningRows(file.screenings)),
    currentRows,
  };
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
}

/**
 * The whole plan. Invalid fields are stripped before calculating (the widget
 * does the same), so one bad number costs its own suggestion, not the report.
 */
export function computePlan(file: RoadmapFile, now = new Date()): Plan {
  const derived = derivePlanInputs(file);
  let inputs = derived.inputs;
  let excluded: string[] = [];

  const validation = validateHealthInputs(inputs);
  if (!validation.success && validation.errors) {
    const invalid = new Set(validation.errors.issues.map((i) => String(i.path[0])));
    if (invalid.has('heightCm') || invalid.has('sex')) {
      throw new PlanError(
        `This record has no usable height and sex (${Object.values(getValidationErrors(validation.errors)).join('; ')})`,
        'The plan needs both. Open the app and fill in the first two fields, then run this again.',
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
    generatedAt: now.toISOString(),
    today: localDay(now),
    results: calculateHealthResults(inputs as HealthInputs, derived.unitSystem, derived.medications, derived.screenings),
    due: computeReminderSchedule(file, now),
    labs: derivePlanLabs(file),
  };
}

// ---------------------------------------------------------------------------
// Shared shaping — the rows every renderer prints
// ---------------------------------------------------------------------------

/** A printed row: current value or lab. `excluded` marks a value the plan ignored. */
export type DisplayRow = { id: string; label: string; value: unknown; unit: string; date: string; excluded?: boolean };

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
      return {
        id: row.id,
        metric: row.metricType,
        label: METRIC_LABELS[row.metricType] ?? row.metricType,
        value: formatDisplayValue(metric, row.value, plan.unitSystem),
        unit: getDisplayLabel(metric, plan.unitSystem),
        date: String(row.recordedAt ?? '').slice(0, 10),
        excluded: excluded.has(METRIC_TO_FIELD[row.metricType]) || undefined,
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
export function renderJson(plan: Plan): string {
  const { overdue, upcoming } = dueSplit(plan);
  return JSON.stringify(
    {
      instruction: PLAN_INSTRUCTION,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      generatedAt: plan.generatedAt,
      today: plan.today,
      unitSystem: plan.unitSystem,
      profile: {
        sex: plan.inputs.sex,
        age: plan.results.age ?? null,
        heightCm: plan.results.heightCm,
        bmi: plan.results.bmi ?? null,
        bmiCategory: plan.results.bmiCategory ?? null,
        eGFR: plan.results.eGFR ?? null,
        idealBodyWeightKg: plan.results.idealBodyWeight,
        proteinTargetG: plan.results.proteinTarget,
      },
      inputs: plan.inputs,
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
        reason: s.reason ?? null,
        guidelines: s.guidelines ?? [],
        references: s.references ?? [],
      })),
      source: { schema: SCHEMA_URL, tool: 'tools/get-plan.ts', docs: 'docs/agent-access.md' },
    },
    null,
    2,
  );
}
