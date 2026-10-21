// The iOS app's My data tab (US-25 AC4/AC5): what it shows, and every write
// it makes. Each write is health-core's own function, the one the CLI and the
// connector use, so the app follows the record's rules without copying them.
// Values come in and go out in the user's units; the record stores SI.
import { createEmptyFile, type RoadmapFile } from '../../packages/health-core/src/roadmap-file';
import { ROADMAP_DOC } from '../../packages/health-core/src/roadmap-doc';
import { parseLocalisedNumber } from '../../packages/health-core/src/parseNumber';
import { appendMeasurement, correctValue } from '../../packages/health-core/src/record-edits';
import { updateProfile } from '../../packages/health-core/src/mcp-tools';
import { stampProfile, upsertMedication, upsertSupplement } from '../../packages/health-core/src/state-edits';
import { medicationSchema, supplementSchema } from '../../packages/health-core/src/validation';
import { latestActivePerMetric } from '../../packages/health-core/src/measurement-history';
import { BLOOD_TEST_METRICS, METRIC_LABELS, VITAL_METRICS } from '../../packages/health-core/src/mappings';
import {
  detectUnitSystem, formatDisplayValue, getDisplayLabel, toCanonicalValue,
  type MetricType, type UnitSystem,
} from '../../packages/health-core/src/units';

/** One row of Vitals or Blood tests: the plan's current value, if any, in the user's units. */
export interface MyDataRow {
  metric: string;
  label: string;
  unit: string;
  latest: { id: string; value: string; day: string } | null;
}

export interface MyData {
  unitSystem: UnitSystem;
  profile: {
    sex: 'male' | 'female' | null;
    birthYear: number | null;
    birthMonth: number | null;
    height: string | null;
    heightUnit: string;
  };
  vitals: MyDataRow[];
  bloodTests: MyDataRow[];
}

/** Every change the tab can ask for. Numbers are in the user's units. */
export type Edit =
  | { kind: 'profile'; sex?: 'male' | 'female'; birthYear?: number; birthMonth?: number; height?: number }
  | { kind: 'units'; unitSystem: UnitSystem }
  | { kind: 'add'; metric: string; value: number; day?: string }
  | { kind: 'correct'; id: string; value: number }
  /** A medication's current state (US-06): the web's write, history row included. */
  | { kind: 'medication'; medicationKey: string; drugName: string; doseValue?: number | null; doseUnit?: string | null }
  /** A supplement's current state; `status: 'stopped'` is the soft stop (US-06). */
  | { kind: 'supplement'; supplementKey: string; supplementName: string; doseValue?: number | null; doseUnit?: string | null; status: 'active' | 'stopped'; startedAt?: string };

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
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('This file is not a health record.');
  }
  return ROADMAP_DOC.migrate(raw, { deviceId, now });
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

function unitsOf(file: RoadmapFile): UnitSystem {
  return file.profile.unitSystem ?? 'si';
}

export function myData(file: RoadmapFile): MyData {
  const system = unitsOf(file);
  const current = new Map(latestActivePerMetric(file.measurements).map((row) => [row.metricType, row]));
  const row = (metric: string): MyDataRow => {
    const latest = current.get(metric);
    return {
      metric,
      label: METRIC_LABELS[metric] ?? metric,
      unit: getDisplayLabel(metric as MetricType, system),
      latest: latest
        ? { id: latest.id, value: formatDisplayValue(metric as MetricType, latest.value, system), day: latest.recordedAt.slice(0, 10) }
        : null,
    };
  };
  const { sex, birthYear, birthMonth, heightCm } = file.profile;
  return {
    unitSystem: system,
    profile: {
      sex: sex ?? null,
      birthYear: birthYear ?? null,
      birthMonth: birthMonth ?? null,
      height: heightCm === undefined ? null : formatDisplayValue('height', heightCm, system),
      heightUnit: getDisplayLabel('height', system),
    },
    vitals: VITAL_METRICS.map(row),
    // PSA is asked for under prostate screening on the web, not with the blood tests.
    bloodTests: BLOOD_TEST_METRICS.filter((metric) => metric !== 'psa').map(row),
  };
}

export function applyEdit(file: RoadmapFile, edit: Edit, now: string): EditOutcome {
  const system = unitsOf(file);
  switch (edit.kind) {
    case 'profile': {
      const { kind: _kind, height, ...rest } = edit;
      const heightCm = height === undefined ? undefined : toCanonicalValue('height', height, system);
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
    case 'add': {
      const result = appendMeasurement(file, {
        metricType: edit.metric, value: edit.value, unit: getDisplayLabel(edit.metric as MetricType, system), recordedAt: edit.day, now,
      });
      if (result.ok) return { ok: true, file: result.file };
      return { ok: false, reason: result.reason, message: result.message, ...(result.existing ? { existingId: result.existing.id } : null) };
    }
    case 'correct': {
      const target = file.measurements.find((row) => row.id === edit.id);
      const unit = target ? getDisplayLabel(target.metricType as MetricType, system) : undefined;
      const result = correctValue(file, { id: edit.id, newValue: edit.value, unit, now });
      if (result.ok) return { ok: true, file: result.file };
      return { ok: false, reason: result.reason, message: result.message };
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
      const checked = supplementSchema.safeParse(edit);
      if (!checked.success || !checked.data.status) {
        return { ok: false, reason: 'invalid-value', message: checked.success ? 'A supplement is active or stopped.' : checked.error.issues[0]?.message ?? 'Not a supplement.' };
      }
      const { supplementKey, supplementName, doseValue = null, doseUnit = null, status, startedAt } = checked.data;
      return { ok: true, file: upsertSupplement(file, { supplementKey, supplementName, doseValue, doseUnit, status, startedAt }, now).file };
    }
  }
}
