/**
 * The plan pipeline: a record file becomes Brad's protocol (US-30, US-32).
 *
 * Lifted out of `tools/get-plan.ts` so the CLI and the MCP tool layer compute
 * ONE plan and cannot drift. Everything here is pure: no `fs`, no argv, no
 * terminal. The CLI keeps reading the file and rendering text and HTML;
 * `renderJson` is the agent-facing shape, and both surfaces return it.
 */
import { currentValueRows, isCoreRow } from './blood-tests';
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
  type ApiMeasurement,
} from './mappings';
import { latestActivePerMetric } from './measurement-history';
import { cmpStr, dayOf, localDay } from './merge';
import { refLineFor } from './reference-hints';
import { computeReminderSchedule, type ReminderScheduleItem } from './reminder-schedule';
import { BASE_SCHEMA_VERSION, type FileLabValue, type RoadmapFile } from './roadmap-file';
import {
  LIMIT_NOT_GRADED, comparatorOf, egfrAsPrinted, formatValue, limitOf, limitSIText, withComparator, withoutLimit, withRowValue,
  type Comparator, type InputLimit, type LimitField,
} from './lab-limits';
import type { HealthInputs, HealthResults, MedicationInputs, ScreeningInputs, SuggestionInputs } from './types';
import {
  UNIT_DEFS, formatGradedReading, formatGradedValue, getDisplayLabel, unitSystemOf, type MetricType, type UnitSystem,
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
  'person’s values against adult targets and do not suggest medicines; point them to their doctor. When ' +
  '`profile.needsSex` is not empty, the record has no sex: those parts are missing, not normal. Do not work them out ' +
  'yourself; tell the user they need their sex, and ask for it. A value with a `comparator` ("> 60", "< 5") is a lab ' +
  'limit, not the number: say it as printed, never as an exact value, and when `inputs.limits` marks it `graded: false` ' +
  'the plan could not grade it against its cutoff.';

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
  // Vitals from `measurements`, blood tests from their core rows (US-66 AC7).
  const active = currentValueRows(file) as ApiMeasurement[];
  const currentRows = latestActivePerMetric(active);
  const creatinine = currentRows.find((r) => r.metricType === 'creatinine');
  return {
    inputs: withLabEgfr(
      measurementsToInputs(currentRows, fileProfileToApi(file.profile)),
      creatinine ? dayOf(creatinine.recordedAt) : null, labEgfrOf(file.labValues), localDay(now),
    ),
    unitSystem: unitSystemOf(file.profile),
    medications: medicationsToInputs(file.medications),
    screenings: screeningsToInputs(fileScreeningRows(file.screenings)),
    currentRows,
  };
}

/** A lab row as `labEgfrOf` reads it: the file's rows and the widget's both fit. */
type LabRowLike = Pick<FileLabValue, 'id' | 'metricName' | 'value' | 'unit' | 'recordedAt'> & { createdAt?: string; status?: string; comparator?: Comparator };

/**
 * The lab's printed creatinine eGFR and its day: one candidate for the plan's
 * eGFR (US-07 AC7). One printed as a limit carries it (US-12 AC20), and holds
 * `labEgfr` only when the limit decides: the representative, never shown.
 */
export type LabEgfr = Pick<HealthInputs, 'labEgfr'> & Required<Pick<HealthInputs, 'labEgfrDate'>> & { labEgfrLimit?: InputLimit };

/**
 * US-07 AC7: the latest active lab `egfr` row (the creatinine eGFR: never
 * cystatin C or combined), in the catalogue's unit and the schema's range;
 * null when there is none. A limit is graded by US-12 AC20's rule; one that
 * does not decide is still the latest eGFR, never passed over for an older one.
 */
export function labEgfrOf(labValues: readonly LabRowLike[]): LabEgfr | null {
  const rows = labValues.filter((l) => labSlotKey(l.metricName) === 'egfr'
    && l.unit === resolveLabCatalogEntry(l.metricName)?.unit && 'labEgfr' in sanitizeInputs({ labEgfr: l.value }));
  const lab = latestActivePerMetric(rows.map((l) => ({ ...l, metricType: 'egfr' })))[0];
  return lab ? labEgfrFrom(lab.value, dayOf(lab.recordedAt), lab.comparator) : null;
}

/** A lab eGFR candidate from its printed number, day and code: a limit graded by
 *  US-12 AC20's rule, the record's row and the widget's cached copy alike. */
export function labEgfrFrom(value: number, labEgfrDate: string, comparator?: Comparator): LabEgfr {
  const { labEgfr, limits } = withRowValue<Partial<HealthInputs>>({}, 'labEgfr', value, comparator);
  return { ...(labEgfr === undefined ? {} : { labEgfr }), labEgfrDate, ...(limits?.labEgfr ? { labEgfrLimit: limits.labEgfr } : {}) };
}

/**
 * US-07 AC7 (Brad 2026-10-27): the inputs with the lab's printed eGFR set when
 * it is the plan's eGFR, and cleared when it is not. The candidates are `lab`
 * (labEgfrOf) and the eGFR calculated from the creatinine the inputs hold,
 * dated `creatinineDay`. Only an eGFR the plan can calculate competes: a
 * creatinine the schema keeps, a birth year and a sex (AC8). The newer by day wins; on
 * the same day the lab's does, since ours may come from a misread creatinine.
 * A creatinine with no date (typed, not yet saved: `null`) is `today`'s, the
 * day it would be saved with. A newer creatinine the plan cannot calculate
 * from (no sex or no birth year) keeps the lab's, with `labEgfrOutdated` (AC8).
 */
export function withLabEgfr<T extends Partial<HealthInputs>>(
  inputs: T, creatinineDay: string | null, lab: LabEgfr | null, today: string,
): T {
  const { labEgfr: _value, labEgfrDate: _day, labEgfrOutdated: _outdated, limits, ...rest } = inputs;
  const others = withoutLimit(limits, 'labEgfr');
  const kept = others.limits ?? {};
  if (!lab) return { ...rest, ...others } as T;
  const usable = sanitizeInputs({ creatinine: inputs.creatinine, birthYear: inputs.birthYear, sex: inputs.sex });
  // A creatinine printed as a limit is held, but no eGFR is worked out from it (US-12 AC20).
  const newer = (usable.creatinine !== undefined || !!kept.creatinine) && (creatinineDay ?? today) > lab.labEgfrDate;
  if (newer && !kept.creatinine && usable.birthYear !== undefined && usable.sex !== undefined) return { ...rest, ...others } as T;
  // AC8: a newer creatinine the plan cannot read yet, or one printed as a limit, leaves the lab eGFR standing, marked outdated.
  // US-12 AC20: a limit that does not decide stands too, with no number; the
  // plan then has no eGFR, and never works one out from an older creatinine.
  const { labEgfrLimit, ...value } = lab;
  return {
    ...rest, ...value, ...(newer ? { labEgfrOutdated: true } : {}),
    ...(labEgfrLimit ? { limits: { ...kept, labEgfr: labEgfrLimit } } : others),
  } as T;
}

export interface PlanLab {
  /** The row id — what `edit-record.ts correct --id` takes. */
  id: string;
  key: string;
  label: string;
  value: number;
  unit: string;
  date: string;
  /** Printed as a limit: `value` is its bound (US-12 AC20). */
  comparator?: Comparator;
}

/** Latest active row per lab test, named and unit-labelled from the catalogue. A core value is a current value, never listed here (US-66 AC8). */
function derivePlanLabs(file: RoadmapFile): PlanLab[] {
  const active = file.labValues.filter((l) => l.status === 'active' && !isCoreRow(l));
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
        ...comparatorOf(l),
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
 * What the plan computes from (US-07 AC11): the inputs with every field
 * validation refused left out, so the rest still plans. A pair left out as
 * swapped is marked `pressureOrder`, which turns the blood pressure prompt
 * into "check your reading". Null when the height itself is refused: no plan.
 * The plan, the web form and the iPhone all strip through this one rule.
 */
export function planInputsFrom(inputs: Partial<HealthInputs>, validation: ReturnType<typeof validateHealthInputs>): SuggestionInputs | null {
  const issues = validation.errors?.issues ?? [];
  const invalid = new Set(issues.map((i) => String(i.path[0])));
  if (invalid.has('heightCm')) return null;
  const stripped: Record<string, unknown> = { ...inputs };
  let limits = inputs.limits;
  // A field left out goes with its limit (US-12 AC20): an inverted pressure printed as a limit too.
  for (const field of invalid) { stripped[field] = undefined; limits = withoutLimit(limits, field).limits; }
  if (limits) stripped.limits = limits; else delete stripped.limits;
  if (issues.some((i) => i.message === PRESSURE_ORDER)) stripped.pressureOrder = true;
  return stripped as unknown as SuggestionInputs;
}

/**
 * The whole plan. Invalid fields are stripped before calculating (the widget
 * does the same), so one bad number costs its own suggestion, not the report.
 * `unitOverrides`: per-metric display units, the web's per-field toggles (US-05), so a
 * target reads in the unit the person chose for that test; absent, `unitSystem` throughout.
 */
export function computePlan(file: RoadmapFile, now = new Date(), unitOverrides?: Partial<Record<MetricType, UnitSystem>>): Plan {
  const derived = derivePlanInputs(file, now);
  const day = (metric: string) => {
    const row = derived.currentRows.find((r) => r.metricType === metric);
    return row ? dayOf(row.recordedAt) : null;
  };

  const validation = validateHealthInputs(derived.inputs, { systolicBp: day('systolic_bp'), diastolicBp: day('diastolic_bp') }, now);
  // Sex is not required (US-07 AC8): a bad one is stripped like any field, and `needsSex` says what it costs.
  const planInputs = planInputsFrom(derived.inputs, validation);
  if (!planInputs) {
    throw new PlanError(
      `This record has no usable height (${getValidationErrors(validation.errors!).heightCm})`,
      'The plan needs it. Ask the user for their height and set it on the record — with `update_profile` if you ' +
        'have it, otherwise in the app — then run this again.',
    );
  }
  const { pressureOrder, ...inputs } = planInputs;
  return {
    ...derived,
    inputs,
    excluded: [...new Set(validation.errors?.issues.map((i) => String(i.path[0])) ?? [])],
    ...(pressureOrder ? { pressureOrder } : {}),
    generatedAt: now.toISOString(),
    today: localDay(now),
    results: calculateHealthResults(planInputs, derived.unitSystem, derived.medications, derived.screenings, unitOverrides, now),
    due: computeReminderSchedule(file, now),
    labs: derivePlanLabs(file),
  };
}

// ---------------------------------------------------------------------------
// Shared shaping — the rows every renderer prints
// ---------------------------------------------------------------------------

/** A printed row: current value or lab. `excluded` marks a value the plan ignored; `excludedReason` says why when it is not out of range.
 *  `comparator` marks a lab limit, whose `value` already prints its symbol; `notGraded` says the plan could not grade it (US-12 AC20). */
export type DisplayRow = { id: string; label: string; value: unknown; unit: string; date: string; excluded?: boolean; excludedReason?: string; comparator?: Comparator; notGraded?: string };

/** A display row's value as printed: a lab limit with its symbol ("> 45"), whichever list it came from (US-12 AC20). */
export function shownValue(row: DisplayRow): string {
  return typeof row.value === 'number' && row.comparator ? withComparator(String(row.value), row.comparator) : String(row.value);
}

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
      // A lipid with a "<X" line prints on the side the cards grade it (US-07 AC5), HbA1c and Lp(a) on the side of their grade lines (AC12).
      const line = refLineFor(metric);
      const limit = limitOf(plan.inputs, METRIC_TO_FIELD[row.metricType]);
      return {
        id: row.id,
        metric: row.metricType,
        label: METRIC_LABELS[row.metricType] ?? row.metricType,
        value: row.comparator
          ? formatValue(metric, row.value, plan.unitSystem, row.comparator)
          : line === undefined
          ? formatGradedReading(metric, row.value, plan.unitSystem)
          : formatGradedValue(metric, row.value, plan.unitSystem, line),
        ...comparatorOf(row),
        ...(limit && !limit.graded ? { notGraded: LIMIT_NOT_GRADED } : {}),
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

/**
 * US-07 AC8, US-32: what a plan without sex leaves out. `planPayload` lists it
 * as `profile.needsSex` when the record has no sex, so an agent knows these parts are
 * missing, not clear, and asks for sex rather than working them out itself.
 */
export const NEEDS_SEX: readonly string[] = [
  'profile.idealBodyWeightKg and profile.proteinTargetG (null) and the protein-target suggestion',
  'profile.eGFR when it would be calculated from creatinine (a lab-printed eGFR still shows, but with a newer creatinine it opens no potassium advice)',
  'the low-HDL suggestion: its line differs by sex',
  'the sex-specific screening suggestions and reminders: breast, cervical, prostate, endometrial and bone density',
];

/** The inputs as an agent reads them: a field read from a limit holds the
 *  limit as printed ("> 1.5", SI), never the representative the plan graded
 *  it with; an ungraded one is there too. `limits` says which (US-12 AC20). */
function limitedInputs(inputs: Partial<HealthInputs>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...inputs };
  for (const [field, limit] of Object.entries(inputs.limits ?? {})) out[field] = limitSIText(field as LimitField, limit);
  return out;
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
      sex: plan.inputs.sex ?? null,
      age: plan.results.age ?? null,
      heightCm: plan.results.heightCm,
      bmi: plan.results.bmi ?? null,
      bmiCategory: adult?.bmiCategory ?? null,
      waistToHeightRatio: plan.results.waistToHeightRatio ?? null,
      // A lab eGFR printed as a limit is said as printed, never as the plan's representative (US-12 AC20).
      eGFR: egfrAsPrinted(plan.inputs, adult) ?? null,
      idealBodyWeightKg: adult?.idealBodyWeight ?? null,
      proteinTargetG: adult?.proteinTarget ?? null,
      // Inside `profile`, a free-form object, so tools/list stays frozen (US-35 AC13).
      needsSex: plan.inputs.sex ? [] : NEEDS_SEX,
    },
    inputs: limitedInputs(plan.inputs),
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
