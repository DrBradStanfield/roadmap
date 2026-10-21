/**
 * Readings from a device's health store (Apple Health on the iPhone) taken
 * into the record (US-25 AC8, ios/architecture.md D6, Brad 2026-10-21).
 *
 * The app reads the store; this decides what lands. The rules:
 *  - Each reading is an APPENDED row with the store's source and the store's
 *    own id in `externalId`. A reading whose id any row already carries,
 *    entered-in-error included, is never taken again: a sample the person
 *    corrected must not come back.
 *  - A reading fills an empty (metric, day) slot, or replaces a slot whose
 *    active row came from the same store and was measured EARLIER that day,
 *    as a FHIR correction (`correctsId`, the old row `entered-in-error`). It
 *    never supersedes a value a person typed or corrected: otherwise a scale
 *    re-sync would undo the person's correction every time.
 *  - A reading measured before the record's erase is skipped: the erase
 *    removed the rows that would have deduplicated it.
 *  - Deletions in the store are not handed over at all: the record is
 *    append-only (Brad 2026-09-24).
 *  - Height is the profile's, not a row: it fills an empty height only.
 *
 * The row's `recordedAt` is the phone's wall-clock time of the reading,
 * written in the shape the web writes its local day (`…T00:00:00.000Z`): its
 * first ten characters are the day the person lived, which is the slot key
 * everywhere (`dayOf`), and its time orders two readings of one day.
 */
import { localDay } from './merge';
import { isCalendarDay } from './measurement-history';
import { measurementValueFault, newId, slotKey, stampUpdatedAt } from './record-edits';
import { createMeasurement, type FileMeasurement, type RoadmapFile } from './roadmap-file';
import { stampProfile } from './state-edits';
import { healthInputSchema, type MeasurementSource, METRIC_TYPES } from './validation';

/** One reading from the store, already in the record's SI units. */
export interface DeviceSample {
  /** The store's own id for the reading (a HealthKit sample UUID). */
  externalId: string;
  /** A core metric (`METRIC_TYPES`), or `height` for the profile. */
  metricType: string;
  /** SI canonical: kg, cm, mmHg. */
  value: number;
  /** When it was measured, as an instant (ISO 8601): compared with the erase. */
  measuredAt: string;
  /** The same moment on the phone's clock, `YYYY-MM-DDTHH:mm:ss`: its day is the slot. */
  localTime: string;
}

export interface DeviceImportResult {
  /** The record with the readings in; the SAME object when nothing changed. */
  file: RoadmapFile;
  /** Readings that filled an empty day. */
  added: number;
  /** Readings that replaced an earlier reading of the same day from the store. */
  replaced: number;
  heightSet: boolean;
  skipped: {
    /** Already in the record, by `externalId`. */
    known: number;
    /** The day holds a value a person typed or corrected. */
    held: number;
    /** The day holds a later reading from the store. */
    earlier: number;
    /** Measured before the record's erase. */
    erased: number;
    /** Not a metric the record tracks, out of range, a future day or an unreadable time. */
    invalid: number;
  };
}

const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

/** The reading's slot day, or null when its time is unreadable or not yet lived. */
function dayOfReading(sample: DeviceSample, now: string): string | null {
  if (typeof sample.localTime !== 'string' || !LOCAL_TIME.test(sample.localTime)) return null;
  const day = sample.localTime.slice(0, 10);
  return isCalendarDay(day) && day <= localDay(now) ? day : null;
}

function heightFault(value: number): boolean {
  return !Number.isFinite(value) || !healthInputSchema.shape.heightCm.safeParse(value).success;
}

export function importDeviceSamples(
  file: RoadmapFile,
  samples: DeviceSample[],
  options: { now: string; source: Extract<MeasurementSource, 'apple_health' | 'fitbit'> },
): DeviceImportResult {
  const { now, source } = options;
  const result: DeviceImportResult = {
    file, added: 0, replaced: 0, heightSet: false, skipped: { known: 0, held: 0, earlier: 0, erased: 0, invalid: 0 },
  };
  const erasedAt = file.meta.erasedAt ? Date.parse(file.meta.erasedAt) : null;
  const known = new Set(file.measurements.flatMap((row) => (row.externalId ? [row.externalId] : [])));
  // Copied once and edited in place, with an index of each slot's active row:
  // a first import can carry years of readings.
  const measurements = [...file.measurements];
  const activeAt = new Map<string, number>();
  measurements.forEach((row, i) => { if (row.status === 'active') activeAt.set(slotKey('measurement', row.metricType, row.recordedAt), i); });
  let height: DeviceSample | null = null;

  // Measured order, so the day's latest reading is the one left active.
  const ordered = [...samples].sort((a, b) => (a.localTime < b.localTime ? -1 : a.localTime > b.localTime ? 1 : 0));
  for (const sample of ordered) {
    if (known.has(sample.externalId)) { result.skipped.known++; continue; }
    const day = dayOfReading(sample, now);
    if (day === null || typeof sample.externalId !== 'string' || !sample.externalId) { result.skipped.invalid++; continue; }
    const measured = Date.parse(sample.measuredAt);
    if (Number.isNaN(measured)) { result.skipped.invalid++; continue; }
    if (erasedAt !== null && measured < erasedAt) { result.skipped.erased++; continue; }

    if (sample.metricType === 'height') {
      if (heightFault(sample.value)) result.skipped.invalid++;
      else height = sample;
      continue;
    }
    if (!(METRIC_TYPES as readonly string[]).includes(sample.metricType) || measurementValueFault(sample.metricType, sample.value)) {
      result.skipped.invalid++;
      continue;
    }

    const recordedAt = `${sample.localTime}.000Z`;
    const key = slotKey('measurement', sample.metricType, recordedAt);
    const heldAt = activeAt.get(key);
    const held = heldAt === undefined ? undefined : measurements[heldAt];
    if (held && held.source !== source) { result.skipped.held++; continue; }
    if (held && held.recordedAt >= recordedAt) { result.skipped.earlier++; continue; }

    const row: FileMeasurement = createMeasurement({
      id: newId(), metricType: sample.metricType, value: sample.value, recordedAt, createdAt: now,
      source, externalId: sample.externalId, ...(held ? { correctsId: held.id } : null),
    });
    if (held && heldAt !== undefined) {
      measurements[heldAt] = { ...held, status: 'entered-in-error' };
      result.replaced++;
    } else {
      result.added++;
    }
    activeAt.set(key, measurements.length);
    measurements.push(row);
    known.add(sample.externalId);
  }

  if (result.added + result.replaced > 0) {
    result.file = stampUpdatedAt({ ...file, measurements }, now);
  }
  if (height) {
    if (file.profile.heightCm === undefined) {
      result.file = stampProfile(result.file, { heightCm: height.value }, now);
      result.heightSet = true;
    } else {
      result.skipped.held++;
    }
  }
  return result;
}
