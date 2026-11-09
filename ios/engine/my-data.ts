// The iOS app's My data tab (US-25 AC4/AC5): what it shows, and every write
// it makes. Each write is health-core's own function, the one the CLI and the
// connector use, so the app follows the record's rules without copying them.
// Values come in and go out in the user's units; the record stores SI. Web
// twins: the widget's InputPanel.tsx and BloodTestTimeline.tsx, writing through
// RoadmapStore.
import { createEmptyFile, type FileLabValue, type FileMeasurement, type RoadmapFile } from '../../packages/health-core/src/roadmap-file';
import type { Plan } from '../../packages/health-core/src/plan';
import { ROADMAP_DOC } from '../../packages/health-core/src/roadmap-doc';
import { SchemaTooNewError } from '../../packages/health-core/src/migrate';
import { parseLocalisedNumber } from '../../packages/health-core/src/parseNumber';
import { addLabValue, appendMeasurement, bulkAppendValues, correctValue, validDay } from '../../packages/health-core/src/record-edits';
import { labRows, type Extraction } from './lab-review';
import { updateProfile } from '../../packages/health-core/src/mcp-tools';
import { stampProfile, upsertMedication, upsertSupplement } from '../../packages/health-core/src/state-edits';
import { medicationSchema, supplementSchema, zod3Message } from '../../packages/health-core/src/validation';
import { customSupplementAdd, customSupplementMatch } from '../../packages/health-core/src/input-form';
import { compareReadings, latestActivePerMetric } from '../../packages/health-core/src/measurement-history';
import { bloodTableReport, bloodTestKeyOf, currentValueRows, isActive, isCoreRow } from '../../packages/health-core/src/blood-tests';
import { importDeviceSamples, type DeviceSample } from '../../packages/health-core/src/device-import';
import { importHealthRecords, type ClinicalRecordInput, type HealthRecordsCounts } from '../../packages/health-core/src/health-records-import';
import { applyFormEdit, formsOf, gradeContextOf, planOf, rowText, ungradedLimit, type FormEdit, type FormsView } from './my-data-forms';
import { BLOOD_TEST_METRICS, METRIC_LABELS, VITAL_METRICS } from '../../packages/health-core/src/mappings';
import { METRIC_GUIDES, type MetricGuide } from '../../packages/health-core/src/metric-guides';
import { APPLE_LOW_FROM_60, FRIEND_2022_TREADMILL, type Vo2MaxCutPoints } from '../../packages/health-core/src/vo2max-bands';
import { calculateAge } from '../../packages/health-core/src/calculations';
import { rowTarget } from '../../packages/health-core/src/row-target';
import { gradeWords, limitUngraded, pressureStatus, valueStatus, type GradeContext, type GradeStatus, type PressureReading } from '../../packages/health-core/src/row-grade';
import { labSeriesRows } from '../../packages/health-core/src/lab-series';
import { displayLabUnit, labSlotKey, resolveLabCatalogEntry } from '../../packages/health-core/src/lab-catalog';
import { trendWindow } from '../../packages/health-core/src/recent-trend';
import { isAlcoholAnswer, type AlcoholAnswer } from '../../packages/health-core/src/types';
import { readableView, unreadableNote } from '../../packages/health-core/src/readable-rows';
import {
  cmToFeetInches, detectUnitSystem, feetInchesToCm, formatDisplayValue, getDisplayLabel, LPA_UNITS, toCanonicalValue, UNIT_DEFS,
  type LpaUnit, type MetricType, type UnitSystem,
} from '../../packages/health-core/src/units';
import { applyPressure, BLOOD_PRESSURE, pressureHistory, type PressureEdit } from './blood-pressure';
import { applyChatEdit, type ChatEdit } from './chat-edits';
import { cellUnitFor, lpaUnitOf, SWITCHABLE, unitsOf, type UnitChoices } from './unit-choices';
import { cellFromSI, cellLabel, cellRange, isLpaUnit, labRangeMessage, type CellUnit } from '../../packages/health-core/src/cell-unit';
import { LIMIT_NOT_GRADED, comparatorOf, isComparator } from '../../packages/health-core/src/lab-limits';

/** One row of Vitals or Blood tests: the plan's current value, if any, in the user's units. */
export interface MyDataRow {
  metric: string;
  label: string;
  unit: string;
  /** `value` reads a lab limit with its symbol, "> 60" (US-12 AC20). */
  latest: { id: string; value: string; day: string } | null;
  /** The recent days' exact values (`trends`), oldest first, in the user's units; a limit is no point on it (US-12 AC20). Unlike the web's
   *  Trend sparkline (BloodTestTimeline.tsx), which draws the full series, iOS shows only
   *  recent data, as Apple Health does (US-25 AC17f). Blood pressure's is its systolic half. */
  trend: number[];
  /** Whether this test has its own Metric/US choice, as the web's unit chip (not Lp(a), height or blood pressure). */
  switchable: boolean;
  /** The target the value is read against, as the web's row prints it under the name (US-62 AC9):
   *  health-core's `rowTarget(...).bare`, such as "Optimal <2.6" or "Target <130/80"; null when none. */
  target: string | null;
  /** The value before the latest, in the same units: the newest earlier day's active value, the
   *  web's "(74)" (US-62 AC8); null with fewer than two days. */
  previous: string | null;
  /** The value's grade, as the web's row colours it (health-core `valueStatus`, US-62 AC8): "warn"
   *  amber, "bad" red, "ok" plain; null when ungraded (no value, no line, a known minor, PSA, a lab test). */
  status: GradeStatus;
  /** The grade as a screen reader hears it after the value, off target only: "above optimal"
   *  (health-core `gradeWords`); null on target or ungraded. */
  gradeWords: string | null;
  /** "Printed as a limit, so the plan cannot grade it against its cutoff.": a latest value printed as a
   *  limit the shared rule leaves ungraded, though there is a plan to grade it by (US-12 AC21); else null. */
  note: string | null;
  /** "lab" on a lab test's row (US-25 AC25): the page, its history and its adds are the lab test's,
   *  whatever its name. Absent on a core metric's row. */
  series?: 'lab';
}

export interface MyData {
  unitSystem: UnitSystem;
  /** Lp(a)'s unit, the web's three-unit control (US-05 AC2): the record's choice, else the units' default. */
  lpaUnit: LpaUnit;
  /** How many times the record was erased, anywhere: a rise starts the phone's questions again (US-54 AC7). */
  eraseEpoch: number;
  /** US-65: the one line saying how many entries this engine could not read and left
   *  in the file; null when there are none. The count only, never what they hold. */
  unreadableNote: string | null;
  profile: {
    sex: 'male' | 'female' | null;
    birthYear: number | null;
    birthMonth: number | null;
    height: string | null;
    heightUnit: string;
    /** A US height as the web shows it, 5 ft 10 in; null in metric or with no height. */
    feetInches: { feet: number; inches: number } | null;
    /** "Do you drink alcohol?" (US-60): null when not answered, or a value this engine does not know. */
    alcohol: AlcoholAnswer | null;
  };
  vitals: MyDataRow[];
  bloodTests: MyDataRow[];
  /** PSA, asked for under prostate screening (US-25 AC8). */
  psa: MyDataRow;
  /** The lab tests beyond the core ones, one row per series as the web's Blood tests rows list them
   *  (MyDataRows.tsx labRows, US-62 AC8): catalogue label, the printed "Ref …" range, the newest value
   *  as reported and the one before it, unless the series mixes units. `metric` is the series key. */
  labTests: MyDataRow[];
  /** The "about this measure" guides (US-58), by metric or medication key: served here so a
   *  correction ships over the air (D3). */
  guides: Record<string, MetricGuide>;
  /** The VO2 max bands' row for the person's sex and age today (US-56 AC8, FRIEND 2022); null
   *  without both, under 20 or at 90 and over. `p20` is the Low line: from 60, Apple's
   *  (APPLE_LOW_FROM_60). Only the table comes out: no VO2 max goes in (AC1). */
  vo2Bands: (Vo2MaxCutPoints & { sex: 'male' | 'female' }) | null;
  /** Each metric's input range (`cellRange`) by unit: "si", "conventional", and Lp(a)'s own
   *  three. What a typed "1,234" is read against (US-02 AC7); input bounds, not targets. */
  inputRanges: Record<string, Record<string, { min: number; max: number }>>;
}

/** Every change the tab can ask for. Numbers are in the user's units. */
export type Edit =
  | { kind: 'profile'; sex?: 'male' | 'female'; birthYear?: number; birthMonth?: number; height?: number; heightFeet?: number; heightInches?: number }
  /** Systolic and diastolic for one day, both or neither (blood-pressure.ts). */
  | PressureEdit
  | { kind: 'units'; unitSystem: UnitSystem }
  /** "Do you drink alcohol?" (US-60): set from the plan card or About you; null clears it. */
  | { kind: 'alcohol'; alcohol: AlcoholAnswer | null }
  /** Lp(a)'s unit, written to the record as the web writes it (US-05 AC2). */
  | { kind: 'lpaUnit'; unit: LpaUnit }
  | { kind: 'add'; metric: string; value: number; day?: string }
  | { kind: 'correct'; id: string; value: number }
  /** A medication's current state (US-06): the web's write, history row included. */
  | { kind: 'medication'; medicationKey: string; drugName: string; doseValue?: number | null; doseUnit?: string | null }
  /** A supplement's current state; `status: 'stopped'` is the soft stop (US-06). */
  | { kind: 'supplement'; supplementKey: string; supplementName: string; doseValue?: number | null; doseUnit?: string | null; status: 'active' | 'stopped'; startedAt?: string }
  /** Readings from Apple Health (US-25 AC13): health-core's device-import decides what lands. */
  | { kind: 'appleHealth'; samples: DeviceSample[] }
  /** Lab results from Health Records (US-72): health-core's health-records-import decides what lands. */
  | { kind: 'healthRecords'; records: ClinicalRecordInput[] }
  /** Medication and screening answers and a typed supplement (my-data-forms.ts, US-25 AC8). */
  | FormEdit
  /** The ticked values of an uploaded lab report (US-52 AC8), written by the web's bulk rule. */
  | { kind: 'labImport'; extractionJson: string; refs: string[]; reportDay: string }
  /** A new value for a lab test the record holds, on a day, in the unit the sheet showed (US-25 AC25):
   *  health-core's `addLabValue`, the web's lab add too, named by its series key (`labSlotKey`). */
  | { kind: 'labAdd'; series: string; value: number; day?: string; unit?: string }
  /** The add sheet's add (US-73 AC8): any test by name, in the unit typed, as the web's general add
   *  (AddLabTest.tsx). An engine before it knows no such kind, and the edit fails. */
  | { kind: 'labAddName'; name: string; value: number; unit: string; day?: string }
  /** What the chat proposed, and its medications' Undo (US-67, chat-edits.ts). */
  | ChatEdit;

/** A refusal leaves the record as it was. `existingId` names the row holding the day. */
export type EditOutcome =
  /** `healthRecords`: what a Health Records batch did (US-72), counts only. */
  | { ok: true; file: RoadmapFile; healthRecords?: HealthRecordsCounts }
  | { ok: false; reason: string; message: string; existingId?: string };

/**
 * Words meant for the person. HealthEngine shows them as they are; any other
 * exception's text stays hidden (US-25 AC6b, review R8).
 */
export class Refusal extends Error {
  override name = 'Refusal';
}

/**
 * The record on disk, read as every other writer reads it (ROADMAP_DOC: the
 * shape check, then the migration). JSON that is not an object, or a record
 * with a broken part, is refused: the migration would quietly empty it, and
 * the app's next save would write over whatever the file held.
 */
/** The record as the screens read it (US-65): `readRecord`, less the rows and profile
 *  fields this engine cannot read. They stay in the file; edits and merges take `readRecord`. */
export function readView(text: string, now: string, deviceId: string): RoadmapFile {
  return readableView(readRecord(text, now, deviceId)).file;
}

export function readRecord(text: string, now: string, deviceId: string): RoadmapFile {
  if (kept && kept.text === text && kept.deviceId === deviceId) return kept.file;
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Refusal('This file is not a health record.');
  }
  let file: RoadmapFile;
  try {
    file = ROADMAP_DOC.migrate(raw, { deviceId, now });
  } catch (error) {
    if (error instanceof SchemaTooNewError) throw new Refusal('A newer version of Health Roadmap wrote this record. Update the app to open it.');
    throw error;
  }
  kept = { text, deviceId, file: FREEZE_KEPT ? deepFreeze(file) : file, moved: movedBloodTests(raw, file) };
  return file;
}

/**
 * US-66 AC14: reading `stored`, the record as saved, moved blood tests out of
 * `measurements` or folded old lab rows named like a core test, so `file` is
 * written once. A moved record has nothing left to move. The web's twin:
 * RoadmapStore.writeMovedRecord.
 */
export function movedBloodTests(stored: unknown, file: RoadmapFile): boolean {
  if (typeof stored !== 'object' || stored === null) return false;
  const rows = <T>(key: string): T[] => {
    const list = (stored as Record<string, unknown>)[key];
    return Array.isArray(list) ? list.filter((row): row is T => typeof row === 'object' && row !== null) : [];
  };
  const report = bloodTableReport({ measurements: rows<FileMeasurement>('measurements'), labValues: rows<FileLabValue>('labValues') }, file);
  return report.moved + report.folded > 0;
}

/** The record to write once, as text, when reading `text` moved it (US-66 AC14); else null. */
export function movedRecord(text: string, now: string, deviceId: string): string | null {
  const file = readRecord(text, now, deviceId); // sets `kept` to this text's read
  return kept!.moved ? JSON.stringify(file) : null;
}

/**
 * The last record read, so the next call on the same text skips the parse and
 * migration (US-25 AC2, D2: they are most of a call's time). Every door treats a
 * read record as read-only: the slot hands the same object to the next call.
 * Only reads are kept, never a door's own output: a written record need not be
 * what its text reads back as (migration clamps counters), so the next call reads
 * that text once, cold (Codex R1).
 * `deviceId` is in the key because the migration falls back to it for a missing
 * `meta.lastDeviceId`. Metadata clock recovery is deterministic even when both
 * stamps are missing or malformed, so migration never depends on `now`.
 */
let kept: { text: string; deviceId: string; file: RoadmapFile; moved: boolean } | null = null;

/** Under the tests the kept record is frozen, so every engine test checks the
 *  read-only rule on every branch it runs (adversary R1). Never in the app. */
const FREEZE_KEPT = typeof process !== 'undefined' && !!process.env?.VITEST;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

/**
 * A typed number, read by the web's rule: either decimal mark, nothing else.
 * An Arabic or Persian keypad types its own digits and the Arabic decimal
 * mark (٫); they become ASCII first, or Save would never light up.
 */
export function readNumber(text: string): number | undefined {
  const ascii = text
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, '.');
  return parseLocalisedNumber(ascii);
}

/** A first-launch record. Units follow the phone's region, as the web's do. */
export function newRecord(now: string, deviceId: string, locale: string, timeZone: string): RoadmapFile {
  const file = createEmptyFile({ deviceId, now });
  return { ...file, profile: { ...file.profile, unitSystem: detectUnitSystem(locale, timeZone) } };
}

/** `plan`: the record's plan for `now` and `choices` (null: it could not be made); a caller
 *  that has it passes it, so the forms are not planned twice (entry.ts screenJson). */
export function myData(file: RoadmapFile, now = new Date().toISOString(), choices: UnitChoices = {}, plan: Plan | null = planOf(file, now, choices)): MyData & FormsView {
  const system = unitsOf(file);
  const current = new Map(latestActivePerMetric(currentValueRows(file)).map((row) => [row.metricType, row]));
  const days = activeDays(file);
  const trend = trends(days, now, (metric, valueSI) => cellFromSI(metric as MetricType, valueSI, cellUnitFor(file, metric, choices)));
  // What the web's rows grade against (InputPanel.tsx rowCtx): none for a known minor (US-07 AC6),
  // and the plan's age, weight target and height once there is a plan.
  const graded = gradeContextOf(file, now, plan);
  const { grading, plan: basis } = graded;
  const row = (metric: string): MyDataRow => {
    const latest = current.get(metric);
    const shown = cellUnitFor(file, metric, choices);
    const day = latest?.recordedAt.slice(0, 10);
    const before = day && [...(days.get(metric)?.keys() ?? [])].filter((d) => d < day).sort().at(-1);
    return {
      metric,
      label: METRIC_LABELS[metric] ?? metric,
      unit: cellLabel(metric as MetricType, shown),
      latest: latest
        ? { id: latest.id, value: rowText(metric as MetricType, latest, shown), day: latest.recordedAt.slice(0, 10) }
        : null,
      trend: trend.get(metric) ?? [],
      switchable: SWITCHABLE.has(metric),
      target: rowTarget(metric as MetricType, shown, grading, basis)?.bare ?? null,
      previous: before ? rowText(metric as MetricType, days.get(metric)!.get(before)!, shown) : null,
      ...gradeOf(latest ? valueStatus(metric as MetricType, latest.value, graded, comparatorOf(latest).comparator) : null, metric),
      note: latest && ungradedLimit(metric as MetricType, latest, graded) ? LIMIT_NOT_GRADED : null,
    };
  };
  const { sex, birthYear, birthMonth, heightCm } = file.profile;
  return {
    unitSystem: system,
    lpaUnit: lpaUnitOf(file),
    eraseEpoch: file.meta.eraseEpoch ?? 0,
    unreadableNote: unreadableNote(readableView(file).count),
    profile: {
      sex: sex ?? null,
      birthYear: birthYear ?? null,
      birthMonth: birthMonth ?? null,
      // A cleared height is a stamped null (US-10 AC9): no height, like an absent one.
      height: heightCm == null ? null : formatDisplayValue('height', heightCm, system),
      heightUnit: getDisplayLabel('height', system),
      feetInches: heightCm == null || system !== 'conventional' ? null : cmToFeetInches(heightCm),
      alcohol: isAlcoholAnswer(file.profile.alcohol) ? file.profile.alcohol : null,
    },
    // Blood pressure is one row, as the web's matrix shows it: the newest day's pair.
    vitals: [...VITAL_METRICS.filter((metric) => metric !== 'systolic_bp' && metric !== 'diastolic_bp').map(row), pressureRow(file, trend, rowTarget('blood_pressure', 'si', grading, basis)?.bare ?? null, graded)],
    // PSA is asked for under prostate screening on the web, not with the blood tests.
    bloodTests: BLOOD_TEST_METRICS.filter((metric) => metric !== 'psa').map(row),
    // The web asks for PSA under screening and never colours it.
    psa: { ...row('psa'), ...gradeOf(null, 'psa'), note: null },
    labTests: labTestRows(file, now),
    guides: METRIC_GUIDES,
    vo2Bands: vo2BandsOf(sex, birthYear, birthMonth, now),
    inputRanges: Object.fromEntries((Object.keys(UNIT_DEFS) as MetricType[]).map((metric) => [metric, Object.fromEntries(
      [...(['si', 'conventional'] as const), ...(metric === 'lpa' ? LPA_UNITS : [])].map((unit) => [unit, cellRange(metric, unit)]),
    )])),
    ...formsOf(file, now, choices, plan),
  };
}

function vo2BandsOf(sex: 'male' | 'female' | undefined, birthYear: number | undefined, birthMonth: number | undefined, now: string): MyData['vo2Bands'] {
  if (!sex || birthYear === undefined) return null;
  const age = calculateAge(birthYear, birthMonth ?? 1, new Date(now));
  const row = FRIEND_2022_TREADMILL[sex].find((r) => age >= r.fromAge && age <= r.toAge);
  return row ? { sex, ...row, p20: age >= 60 ? APPLE_LOW_FROM_60[sex] : row.p20 } : null;
}

export function applyEdit(file: RoadmapFile, edit: Edit, now: string, choices: UnitChoices = {}): EditOutcome {
  const system = unitsOf(file);
  switch (edit.kind) {
    case 'profile': {
      const { kind: _kind, height, heightFeet, heightInches, ...rest } = edit;
      let heightCm = height === undefined ? undefined : toCanonicalValue('height', height, system);
      if (heightFeet !== undefined || heightInches !== undefined) {
        // The web's two fields, read whole (InputPanel.tsx); its range is updateProfile's, in cm.
        if (!Number.isInteger(heightFeet) || !Number.isInteger(heightInches) || heightFeet! < 0 || heightInches! < 0 || heightInches! > 11) {
          return { ok: false, reason: 'invalid-value', message: 'Height is whole feet and 0 to 11 inches.' };
        }
        const shown = typeof file.profile.heightCm === 'number' ? cmToFeetInches(file.profile.heightCm) : undefined;
        // The wheels as they opened: write nothing, so 178 cm never becomes 177.8 (adversary R4).
        if (shown?.feet === heightFeet && shown?.inches === heightInches) {
          if (Object.keys(rest).length === 0) return { ok: true, file };
        } else {
          heightCm = feetInchesToCm(heightFeet!, heightInches!);
        }
      }
      const outcome = updateProfile(file, { ...rest, ...(heightCm === undefined ? null : { heightCm }) }, now);
      // The person's words, not the agent's field key and tail (US-54 AC5c).
      if (outcome.status !== 'ok') return { ok: false, reason: 'invalid-value', message: (outcome.status === 'rejected' && outcome.message) || outcome.text };
      return { ok: true, file: outcome.file ?? file };
    }
    case 'units': {
      if (edit.unitSystem !== 'si' && edit.unitSystem !== 'conventional') {
        return { ok: false, reason: 'invalid-value', message: 'Units are metric or US.' };
      }
      if (edit.unitSystem === file.profile.unitSystem) return { ok: true, file };
      return { ok: true, file: stampProfile(file, { unitSystem: edit.unitSystem }, now) };
    }
    case 'alcohol': {
      if (edit.alcohol !== null && !isAlcoholAnswer(edit.alcohol)) {
        return { ok: false, reason: 'invalid-value', message: 'Alcohol is "none", "drinks" or not answered.' };
      }
      // The same answer again writes nothing. "Not answered" writes null, as every cleared
      // profile field is stored (US-10 AC6, roadmap-file.schema.test.ts), so it merges as a write.
      if (edit.alcohol === (file.profile.alcohol ?? null)) return { ok: true, file };
      return { ok: true, file: stampProfile(file, { alcohol: edit.alcohol }, now) };
    }
    case 'lpaUnit': {
      if (!isLpaUnit(edit.unit)) {
        return { ok: false, reason: 'invalid-value', message: 'Lp(a) is in nmol/L, mg/dL or mg/L.' };
      }
      // The web's write (roadmap-store.ts setLpaUnit): the stored choice again writes nothing.
      if (edit.unit === file.profile.lpaUnit) return { ok: true, file };
      return { ok: true, file: stampProfile(file, { lpaUnit: edit.unit }, now) };
    }
    case 'add': {
      const unit = cellUnitFor(file, edit.metric, choices);
      const result = appendMeasurement(file, {
        // Typed in the unit the row shows (AC17e; Lp(a)'s own, US-05 AC2), which the record converts to SI.
        metricType: edit.metric, value: edit.value, unit: cellLabel(edit.metric as MetricType, unit), recordedAt: edit.day, now,
      });
      if (result.ok) return { ok: true, file: result.file };
      return { ok: false, reason: result.reason, message: typedRangeMessage(edit.metric, edit.value, unit, result), ...(result.existing ? { existingId: result.existing.id } : null) };
    }
    case 'correct': {
      // A blood test is a core lab row (US-66 AC6); a vital is a measurement.
      const core = file.labValues.find((row) => row.id === edit.id && isCoreRow(row));
      const metric = core?.metricName ?? file.measurements.find((row) => row.id === edit.id)?.metricType;
      const shown = metric && cellUnitFor(file, metric, choices);
      const result = correctValue(file, { id: edit.id, newValue: edit.value, unit: shown && cellLabel(metric as MetricType, shown), now });
      if (result.ok) return { ok: true, file: result.file };
      return { ok: false, reason: result.reason, message: shown ? typedRangeMessage(metric!, edit.value, shown, result) : result.message };
    }
    // The web's own writes (state-edits.ts), behind the API's own schemas:
    // the app's input is checked the way a request to the server was.
    case 'medication': {
      const checked = medicationSchema.safeParse(edit, { error: zod3Message });
      if (!checked.success) return { ok: false, reason: 'invalid-value', message: checked.error.issues[0]?.message ?? 'Not a medication.' };
      const { medicationKey, drugName, doseValue = null, doseUnit = null } = checked.data;
      return { ok: true, file: upsertMedication(file, { medicationKey, drugName, doseValue, doseUnit }, now).file };
    }
    case 'supplement': {
      // A key the record holds passes as it is: older browser records hold
      // custom keys over the 100 characters a new key may have (US-06 AC1a).
      const held = file.supplements.some((row) => row.supplementKey === edit.supplementKey);
      const checked = (held ? supplementSchema.omit({ supplementKey: true }) : supplementSchema).safeParse(edit, { error: zod3Message });
      if (!checked.success || !checked.data.status) {
        return { ok: false, reason: 'invalid-value', message: checked.success ? 'A supplement is active or stopped.' : checked.error.issues[0]?.message ?? 'Not a supplement.' };
      }
      const { supplementKey } = edit;
      const { supplementName, doseValue = null, doseUnit = null, status, startedAt } = checked.data;
      // A start is a real day or instant that has happened (rule 9's check).
      if (startedAt !== undefined && (Number.isNaN(Date.parse(startedAt)) || validDay(startedAt, { now }) === null)) {
        return { ok: false, reason: 'invalid-date', message: 'A supplement starts on a real day, today or before.' };
      }
      // Stopping is for a supplement the record holds: a stop for any other
      // key would create a stopped row out of nothing.
      if (status === 'stopped' && !file.supplements.some((row) => row.supplementKey === supplementKey)) {
        return { ok: false, reason: 'not-found', message: 'There is no such supplement to stop.' };
      }
      return { ok: true, file: upsertSupplement(file, { supplementKey, supplementName, doseValue, doseUnit, status, startedAt }, now).file };
    }
    case 'bloodPressure':
      return applyPressure(file, edit, now);
    case 'appleHealth': {
      if (!Array.isArray(edit.samples)) return { ok: false, reason: 'invalid-value', message: 'Apple Health readings come as a list.' };
      return { ok: true, file: importDeviceSamples(file, edit.samples, { now, source: 'apple_health' }).file };
    }
    case 'healthRecords': {
      if (!Array.isArray(edit.records)) return { ok: false, reason: 'invalid-value', message: 'Health Records results come as a list.' };
      const { file: next, counts } = importHealthRecords(file, edit.records, { now });
      return { ok: true, file: next, healthRecords: counts };
    }
    case 'customSupplement':
      // A name already taken keeps its dose: adding it again changes nothing (US-06 AC1a).
      if (customSupplementMatch(edit.name, file.supplements)?.status === 'active') return { ok: true, file };
      return applyEdit(file, { kind: 'supplement', ...customSupplementAdd(edit.name, file.supplements), status: 'active' }, now);
    case 'medicationField':
    case 'screening':
      return applyFormEdit(file, edit, now, (next, save) => applyEdit(next, save, now));
    case 'labImport': {
      const rows = labRows(JSON.parse(edit.extractionJson) as Extraction, edit.refs, edit.reportDay, now);
      if (!rows.ok) return rows;
      // A held day is skipped and a refused unit left out: labSaveSummary says which, beforehand.
      return { ok: true, file: bulkAppendValues(file, rows.rows, now).file };
    }
    case 'labAdd':
      return addSeriesValue(file, edit, now);
    case 'labAddName':
      return addByName(file, edit, now, choices);
    case 'chatEdits':
    case 'chatUndo':
      return applyChatEdit(file, edit, now, choices);
  }
}

/**
 * A lab add (US-25 AC25): health-core's one lab add (`addLabValue`), the web's too. The series' newest
 * row names the test as it was printed; the unit is the one the sheet showed (`unit`), else the
 * series' own, so a row synced in while the sheet was open never changes what the number means.
 */
function addSeriesValue(file: RoadmapFile, edit: Extract<Edit, { kind: 'labAdd' }>, now: string): EditOutcome {
  const rows = file.labValues.filter((row) => !isCoreRow(row) && labSlotKey(row.metricName) === edit.series);
  const named = rows.filter(isActive).sort(compareReadings).at(-1);
  if (!named) return { ok: false, reason: 'not-found', message: 'There is no such lab test in your record.' };
  // A kept-apart row named like a core test (an old "creatinine" may be urine, US-12 AC11): the add would
  // write the core value, which this page never shows. It goes on the core test's own row (US-66 AC5).
  if (bloodTestKeyOf(named.metricName)) return { ok: false, reason: 'core-name', message: 'Add this test from its row in Blood tests.' };
  const unit = edit.unit ?? displayLabUnit(named.unit ?? '', resolveLabCatalogEntry(named.metricName));
  const added = addLabValue(file, { metricName: named.metricName, unit, value: edit.value, day: edit.day, existingSeries: true }, now);
  return added.ok ? { ok: true, file: added.file } : added;
}

/**
 * The add sheet's add by name (US-73 AC8): the web's general add (AddLabTest.tsx), health-core's
 * `addLabValue`. A core test's name writes its core row, range-checked (US-66 AC6); a catalogue
 * test keeps its key and canonical unit, and a unit it does not take is refused (US-21 AC3, AC4);
 * any other name is a new test in the unit typed. A held day names what it holds and offers it for
 * correcting only when the number differs in the same unit (US-21 AC13). Never a second row.
 */
function addByName(file: RoadmapFile, edit: Extract<Edit, { kind: 'labAddName' }>, now: string, choices: UnitChoices): EditOutcome {
  const { name, unit = '' } = edit;
  const added = addLabValue(file, { metricName: name, unit, value: edit.value, day: edit.day }, now);
  if (added.ok) return { ok: true, file: added.file };
  const core = bloodTestKeyOf(name.trim());
  const { bound, refused: _refused, ...refusal } = added;
  // Out of range, in the web's words: the end it missed, in the unit typed.
  const range = bound && core && labRangeMessage(core, unit, bound);
  if (range) return { ...refusal, message: range };
  // The correction is the `correct` edit, which reads its number in the unit the core row shows.
  if (core && refusal.existingId && displayLabUnit(unit) !== cellLabel(core, cellUnitFor(file, core, choices))) {
    const { existingId: _held, ...rest } = refusal;
    return rest;
  }
  return refusal;
}

/** An Lp(a) value out of range, said in the unit it was typed in with the web's range
 *  (`cellRange`, its matrix's "Max 3000 mg/L"); the record's words, in nmol/L, are for an agent.
 *  Any other refusal keeps the record's words. */
function typedRangeMessage(metric: string, typed: number, unit: CellUnit, refusal: { reason: string; message: string }): string {
  if (metric !== 'lpa' || refusal.reason !== 'out-of-range') return refusal.message;
  const { min, max } = cellRange('lpa', unit);
  return typed < min ? `Lp(a) must be at least ${min} ${unit} (got ${typed})` : `Lp(a) must be at most ${max} ${unit} (got ${typed})`;
}

/** The Vitals row for blood pressure: the newest day's pair, from the history's own pairing. */
function pressureRow(file: RoadmapFile, trend: Map<string, number[]>, target: string | null, graded: GradeContext): MyDataRow {
  const shown = new Map<string, PressureReading>();
  const { label, unit, rows } = pressureHistory(file, [], shown);
  const active = rows.filter((row) => row.status === 'active');
  const [newest] = active;
  // The day before's pair, both halves present: a half-pair is no reading (the web's pressureReadings).
  // A half-pair latest ("135/–", US-25 AC17) gets none, so no bracket sits beside a dash.
  const whole = (row?: (typeof rows)[number]) => !!row?.systolic && !!row?.diastolic;
  const previous = whole(newest) ? active.slice(1).find(whole) : undefined;
  // Graded on the stored halves of the pair it shows, as the web grades stored values: a half-pair has
  // no grade, and a half printed as a limit is graded only when certain (US-12 AC21).
  const reading = whole(newest) ? shown.get(newest.id) : undefined;
  const status = reading ? pressureStatus(reading, graded) : null;
  return {
    metric: BLOOD_PRESSURE, label, unit,
    latest: newest ? { id: newest.id, value: newest.value, day: newest.day } : null,
    trend: trend.get('systolic_bp') ?? [],
    switchable: false,
    target,
    previous: previous?.value ?? null,
    ...gradeOf(status, BLOOD_PRESSURE),
    note: reading && limitUngraded(BLOOD_PRESSURE, status, graded, reading) ? LIMIT_NOT_GRADED : null,
  };
}

/** A row's grade and its spoken words. */
function gradeOf(status: GradeStatus, metric: string): Pick<MyDataRow, 'status' | 'gradeWords'> {
  return { status, gradeWords: gradeWords(status, metric) };
}

/** The lab tests beyond the core ones: health-core's rows (`labSeriesRows`), as the web's phone rows
 *  build them (MyDataRows.tsx labRows), in this row's shape; never graded. A limit reads with its
 *  symbol and, as on the core rows, is no point on the trend (US-12 AC20). */
function labTestRows(file: RoadmapFile, now: string): MyDataRow[] {
  // A core row is a blood test's own row above, never a lab test here (US-66 AC7).
  return labSeriesRows(file.labValues.filter((row) => !isCoreRow(row)), new Date(now), true).map(({ seriesKey, label, unit, latest, previous, target, trend }) => ({
    metric: seriesKey, series: 'lab', label, unit, latest, trend, switchable: false, target, previous, ...gradeOf(null, seriesKey), note: null,
  }));
}

/** A current value: a vital, or a core blood-test row shaped as one (US-66 AC7). */
type ValueRow = ReturnType<typeof currentValueRows>[number];

/** Each metric's active row per day (the slot's first, as findActiveInSlot reads it), in one pass:
 *  the vitals and the core blood-test rows (US-66 AC7). */
function activeDays(file: RoadmapFile): Map<string, Map<string, ValueRow>> {
  const byMetric = new Map<string, Map<string, ValueRow>>();
  for (const row of currentValueRows(file)) {
    const days = byMetric.get(row.metricType) ?? new Map<string, ValueRow>();
    byMetric.set(row.metricType, days);
    const day = row.recordedAt.slice(0, 10);
    if (!days.has(day)) days.set(day, row);
  }
  return byMetric;
}

/** Every metric's trend, from `activeDays`, oldest first. As Apple Health, the last 30 days (today, the
 *  phone's local day, and the 29 before), or the last seven days however old when those 30
 *  hold fewer than two (US-25 AC17f). A day after today (an import that kept another zone's
 *  offset) is left out of both, as the phone leaves out a night dated after today. */
function trends(byMetric: Map<string, Map<string, ValueRow>>, now: string, shown: (metric: string, valueSI: number) => number): Map<string, number[]> {
  const recent = trendWindow(new Date(now));
  const out = new Map<string, number[]>();
  for (const [metric, days] of byMetric) {
    // A day whose row is a lab limit has no exact value to draw (US-12 AC20).
    const exact = [...days.keys()].filter((day) => !isComparator(days.get(day)!.comparator)).sort();
    out.set(metric, recent(exact, (day) => day).map((day) => shown(metric, days.get(day)!.value)));
  }
  return out;
}
