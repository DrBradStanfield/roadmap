// The iOS app's My data tab (US-25 AC4/AC5): what it shows, and every write
// it makes. Each write is health-core's own function, the one the CLI and the
// connector use, so the app follows the record's rules without copying them.
// Values come in and go out in the user's units; the record stores SI. Web
// twins: the widget's InputPanel.tsx and BloodTestTimeline.tsx, writing through
// RoadmapStore.
import { createEmptyFile, type RoadmapFile } from '../../packages/health-core/src/roadmap-file';
import type { Plan } from '../../packages/health-core/src/plan';
import { ROADMAP_DOC } from '../../packages/health-core/src/roadmap-doc';
import { hasStampShape } from '../../packages/health-core/src/migrate';
import { parseLocalisedNumber } from '../../packages/health-core/src/parseNumber';
import { appendMeasurement, bulkAppendValues, correctValue, validDay } from '../../packages/health-core/src/record-edits';
import { labRows, type Extraction } from './lab-review';
import { updateProfile } from '../../packages/health-core/src/mcp-tools';
import { stampProfile, upsertMedication, upsertSupplement } from '../../packages/health-core/src/state-edits';
import { medicationSchema, supplementSchema } from '../../packages/health-core/src/validation';
import { customSupplementAdd, customSupplementMatch } from '../../packages/health-core/src/input-form';
import { latestActivePerMetric } from '../../packages/health-core/src/measurement-history';
import { importDeviceSamples, type DeviceSample } from '../../packages/health-core/src/device-import';
import { applyFormEdit, formsOf, planOf, type FormEdit, type FormsView } from './my-data-forms';
import { BLOOD_TEST_METRICS, METRIC_LABELS, VITAL_METRICS } from '../../packages/health-core/src/mappings';
import {
  cmToFeetInches, detectUnitSystem, feetInchesToCm, formatDisplayValue, getDisplayLabel, toCanonicalValue,
  type LpaUnit, type MetricType, type UnitSystem,
} from '../../packages/health-core/src/units';
import { applyPressure, BLOOD_PRESSURE, pressureHistory, type PressureEdit } from './blood-pressure';
import { cellUnitFor, lpaUnitOf, SWITCHABLE, unitsOf, type UnitChoices } from './unit-choices';
import { cellFromSI, cellLabel, cellRange, cellText, isLpaUnit, type CellUnit } from '../../packages/health-core/src/cell-unit';

/** One row of Vitals or Blood tests: the plan's current value, if any, in the user's units. */
export interface MyDataRow {
  metric: string;
  label: string;
  unit: string;
  latest: { id: string; value: string; day: string } | null;
  /** The newest TREND_POINTS days' values, oldest first, in the user's units: the web's
   *  Trend sparkline (BloodTestTimeline.tsx). Blood pressure's is its systolic half. */
  trend: number[];
  /** Whether this test has its own Metric/US choice, as the web's unit chip (not Lp(a), height or blood pressure). */
  switchable: boolean;
}

/** Days a row's trend line holds: enough to show a direction, small enough to send every render. */
export const TREND_POINTS = 30;

export interface MyData {
  unitSystem: UnitSystem;
  /** Lp(a)'s unit, the web's three-unit control (US-05 AC2): the record's choice, else the units' default. */
  lpaUnit: LpaUnit;
  /** How many times the record was erased, anywhere: a rise starts the phone's questions again (US-54 AC7). */
  eraseEpoch: number;
  profile: {
    sex: 'male' | 'female' | null;
    birthYear: number | null;
    birthMonth: number | null;
    height: string | null;
    heightUnit: string;
    /** A US height as the web shows it, 5 ft 10 in; null in metric or with no height. */
    feetInches: { feet: number; inches: number } | null;
  };
  vitals: MyDataRow[];
  bloodTests: MyDataRow[];
  /** PSA, asked for under prostate screening (US-25 AC8). */
  psa: MyDataRow;
}

/** Every change the tab can ask for. Numbers are in the user's units. */
export type Edit =
  | { kind: 'profile'; sex?: 'male' | 'female'; birthYear?: number; birthMonth?: number; height?: number; heightFeet?: number; heightInches?: number }
  /** Systolic and diastolic for one day, both or neither (blood-pressure.ts). */
  | PressureEdit
  | { kind: 'units'; unitSystem: UnitSystem }
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
  /** Medication and screening answers and a typed supplement (my-data-forms.ts, US-25 AC8). */
  | FormEdit
  /** The ticked values of an uploaded lab report (US-52 AC8), written by the web's bulk rule. */
  | { kind: 'labImport'; extractionJson: string; refs: string[]; reportDay: string };

/** A refusal leaves the record as it was. `existingId` names the row holding the day. */
export type EditOutcome =
  | { ok: true; file: RoadmapFile }
  | { ok: false; reason: string; message: string; existingId?: string };

/**
 * The record on disk, read as every other writer reads it (ROADMAP_DOC: the
 * shape check, then the migration). JSON that is not an object, or a record
 * with a broken part, is refused: the migration would quietly empty it, and
 * the app's next save would write over whatever the file held.
 */
export function readRecord(text: string, now: string, deviceId: string): RoadmapFile {
  if (kept && kept.text === text && kept.deviceId === deviceId) return kept.file;
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('This file is not a health record.');
  }
  const file = ROADMAP_DOC.migrate(raw, { deviceId, now });
  kept = nowFree(raw) ? { text, deviceId, file: FREEZE_KEPT ? deepFreeze(file) : file } : null;
  return file;
}

/**
 * The last record read, so the next call on the same text skips the parse and
 * migration (US-25 AC2, D2: they are most of a call's time). Every door treats a
 * read record as read-only: the slot hands the same object to the next call.
 * Only reads are kept, never a door's own output: a written record need not be
 * what its text reads back as (migration clamps counters), so the next call reads
 * that text once, cold (Codex R1).
 * `deviceId` is in the key because the migration falls back to it for a missing
 * `meta.lastDeviceId`. `now` is not: the migration reads it only as the fallback
 * for a `meta.createdAt` or `meta.updatedAt` that does not start yyyy-mm-ddT
 * (migrate.ts isoOr), so a record whose two stamps both do migrates the same at
 * any `now`. Any other record is not kept.
 */
let kept: { text: string; deviceId: string; file: RoadmapFile } | null = null;

/** Whether the record's meta carries both stamps, so `now` cannot change its migration. */
function nowFree(raw: object): boolean {
  const meta = (raw as { meta?: Record<string, unknown> }).meta;
  return typeof meta === 'object' && meta !== null && hasStampShape(meta.createdAt) && hasStampShape(meta.updatedAt);
}

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
  const current = new Map(latestActivePerMetric(file.measurements).map((row) => [row.metricType, row]));
  const trend = trends(file, (metric, valueSI) => cellFromSI(metric as MetricType, valueSI, cellUnitFor(file, metric, choices)));
  const row = (metric: string): MyDataRow => {
    const latest = current.get(metric);
    const shown = cellUnitFor(file, metric, choices);
    return {
      metric,
      label: METRIC_LABELS[metric] ?? metric,
      unit: cellLabel(metric as MetricType, shown),
      latest: latest
        ? { id: latest.id, value: cellText(metric as MetricType, latest.value, shown), day: latest.recordedAt.slice(0, 10) }
        : null,
      trend: trend.get(metric) ?? [],
      switchable: SWITCHABLE.has(metric),
    };
  };
  const { sex, birthYear, birthMonth, heightCm } = file.profile;
  return {
    unitSystem: system,
    lpaUnit: lpaUnitOf(file),
    eraseEpoch: file.meta.eraseEpoch ?? 0,
    profile: {
      sex: sex ?? null,
      birthYear: birthYear ?? null,
      birthMonth: birthMonth ?? null,
      height: heightCm === undefined ? null : formatDisplayValue('height', heightCm, system),
      heightUnit: getDisplayLabel('height', system),
      feetInches: heightCm === undefined || system !== 'conventional' ? null : cmToFeetInches(heightCm),
    },
    // Blood pressure is one row, as the web's matrix shows it: the newest day's pair.
    vitals: [...VITAL_METRICS.filter((metric) => metric !== 'systolic_bp' && metric !== 'diastolic_bp').map(row), pressureRow(file, trend)],
    // PSA is asked for under prostate screening on the web, not with the blood tests.
    bloodTests: BLOOD_TEST_METRICS.filter((metric) => metric !== 'psa').map(row),
    psa: row('psa'),
    ...formsOf(file, now, choices, plan),
  };
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
        const shown = file.profile.heightCm === undefined ? undefined : cmToFeetInches(file.profile.heightCm);
        // The wheels as they opened: write nothing, so 178 cm never becomes 177.8 (adversary R4).
        if (shown?.feet === heightFeet && shown?.inches === heightInches) {
          if (Object.keys(rest).length === 0) return { ok: true, file };
        } else {
          heightCm = feetInchesToCm(heightFeet!, heightInches!);
        }
      }
      const outcome = updateProfile(file, { ...rest, ...(heightCm === undefined ? null : { heightCm }) }, now);
      if (outcome.status !== 'ok') return { ok: false, reason: 'invalid-value', message: outcome.text };
      return { ok: true, file: outcome.file ?? file };
    }
    case 'units': {
      if (edit.unitSystem !== 'si' && edit.unitSystem !== 'conventional') {
        return { ok: false, reason: 'invalid-value', message: 'Units are metric or US.' };
      }
      if (edit.unitSystem === file.profile.unitSystem) return { ok: true, file };
      return { ok: true, file: stampProfile(file, { unitSystem: edit.unitSystem }, now) };
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
      const target = file.measurements.find((row) => row.id === edit.id);
      const shown = target && cellUnitFor(file, target.metricType, choices);
      const result = correctValue(file, { id: edit.id, newValue: edit.value, unit: shown && cellLabel(target!.metricType as MetricType, shown), now });
      if (result.ok) return { ok: true, file: result.file };
      return { ok: false, reason: result.reason, message: shown ? typedRangeMessage(target!.metricType, edit.value, shown, result) : result.message };
    }
    // The web's own writes (state-edits.ts), behind the API's own schemas:
    // the app's input is checked the way a request to the server was.
    case 'medication': {
      const checked = medicationSchema.safeParse(edit);
      if (!checked.success) return { ok: false, reason: 'invalid-value', message: checked.error.issues[0]?.message ?? 'Not a medication.' };
      const { medicationKey, drugName, doseValue = null, doseUnit = null } = checked.data;
      return { ok: true, file: upsertMedication(file, { medicationKey, drugName, doseValue, doseUnit }, now).file };
    }
    case 'supplement': {
      // A key the record holds passes as it is: older browser records hold
      // custom keys over the 100 characters a new key may have (US-06 AC1a).
      const held = file.supplements.some((row) => row.supplementKey === edit.supplementKey);
      const checked = (held ? supplementSchema.omit({ supplementKey: true }) : supplementSchema).safeParse(edit);
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
  }
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
function pressureRow(file: RoadmapFile, trend: Map<string, number[]>): MyDataRow {
  const { label, unit, rows } = pressureHistory(file, []);
  const newest = rows.find((row) => row.status === 'active');
  return {
    metric: BLOOD_PRESSURE, label, unit,
    latest: newest ? { id: newest.id, value: newest.value, day: newest.day } : null,
    trend: trend.get('systolic_bp') ?? [],
    switchable: false,
  };
}

/** Every metric's trend in one pass: each day's active value (the slot's first, as
 *  findActiveInSlot reads it), the newest TREND_POINTS days, oldest first. */
function trends(file: RoadmapFile, shown: (metric: string, valueSI: number) => number): Map<string, number[]> {
  const byMetric = new Map<string, Map<string, number>>();
  for (const row of file.measurements) {
    if (row.status !== 'active') continue;
    const days = byMetric.get(row.metricType) ?? new Map<string, number>();
    byMetric.set(row.metricType, days);
    const day = row.recordedAt.slice(0, 10);
    if (!days.has(day)) days.set(day, row.value);
  }
  const out = new Map<string, number[]>();
  for (const [metric, days] of byMetric) {
    const newest = [...days.keys()].sort().slice(-TREND_POINTS);
    out.set(metric, newest.map((day) => shown(metric, days.get(day)!)));
  }
  return out;
}
