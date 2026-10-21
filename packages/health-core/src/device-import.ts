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
 *  - The two halves of a blood pressure land together or not at all.
 *  - A reading measured before the record's erase is skipped: the erase
 *    removed the rows that would have deduplicated it.
 *  - Deletions in the store are not handed over at all: the record is
 *    append-only (Brad 2026-09-24).
 *  - Height is the profile's, not a row: it fills an empty height only.
 *  These hold on one device. Across devices the merge (merge.ts) keeps the
 *  newest-written row of a slot, which can undo them: cloud-sync work.
 *
 * The row's `recordedAt` is the reading's real instant with the UTC offset of
 * where it was taken (`2026-10-21T08:30:00.000+13:00`). Its first ten
 * characters are the day the person lived, the slot key everywhere (`dayOf`);
 * as an instant it orders a day's readings, and the web shows it as a moment
 * (widget-src/src/lib/constants.ts `formatShortDate`), not as a UTC day. A
 * wall-clock time labelled Z would show on the wrong day (review R1, 2026-10-21).
 */
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
  /**
   * When and where it was measured: the instant with the UTC offset of the
   * zone it was taken in, `2026-10-21T08:30:00+13:00`. Its date is the slot's
   * day; as an instant it orders a day's readings and is compared with the erase.
   */
  measuredAt: string;
  /** Shared by the two halves of one blood pressure: they land together or not at all. */
  pairId?: string;
}

export interface DeviceImportResult {
  /** The record with the readings in; the SAME object when nothing changed. */
  file: RoadmapFile;
  /** Rows that filled an empty day. */
  added: number;
  /** Rows that replaced an earlier reading of the same day from the store. */
  replaced: number;
  heightSet: boolean;
  /** Samples skipped, by reason; a pair counts both halves. */
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

/** An instant with its UTC offset (or Z): the date and time are where the reading was taken. */
const MEASURED_AT = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** A device clock a little ahead of the phone's is not a reading from the future. */
const CLOCK_SKEW_MS = 5 * 60_000;

/**
 * The row's `recordedAt` for a reading, or null when its time is unreadable or
 * has not happened. "Not yet" compares instants: the reading's day is the day
 * where it was taken, which in a zone ahead of the phone's is already the
 * phone's tomorrow (re-check F1, 2026-10-21).
 */
function recordedAtOf(sample: DeviceSample, now: string): string | null {
  const parts = typeof sample.measuredAt === 'string' ? MEASURED_AT.exec(sample.measuredAt) : null;
  const at = parts ? Date.parse(sample.measuredAt) : Number.NaN;
  if (!parts || Number.isNaN(at) || at > Date.parse(now) + CLOCK_SKEW_MS) return null;
  const [, day, time, offset] = parts;
  return isCalendarDay(day) ? `${day}T${time}.000${offset}` : null;
}

function heightFault(value: number): boolean {
  return !Number.isFinite(value) || !healthInputSchema.shape.heightCm.safeParse(value).success;
}

/**
 * The readings that land or fall together: one sample, or both halves of a
 * blood pressure (one `pairId`). Half a pair would put a systolic and a
 * diastolic that were never measured together into the plan as one reading.
 */
function readingsOf(samples: DeviceSample[]): DeviceSample[][] {
  const pairs = new Map<string, DeviceSample[]>();
  const readings: DeviceSample[][] = [];
  for (const sample of samples) {
    if (typeof sample.pairId !== 'string') { readings.push([sample]); continue; }
    const pair = pairs.get(sample.pairId);
    if (pair) { pair.push(sample); continue; }
    const fresh = [sample];
    pairs.set(sample.pairId, fresh);
    readings.push(fresh);
  }
  // Measured order, so the day's latest reading is the one left active.
  const at = (reading: DeviceSample[]) => Date.parse(reading[0].measuredAt) || 0;
  return readings.sort((a, b) => at(a) - at(b));
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

  for (const reading of readingsOf(samples)) {
    const skip = (why: keyof DeviceImportResult['skipped']) => { result.skipped[why] += reading.length; };
    if (reading.some((sample) => known.has(sample.externalId))) { skip('known'); continue; }
    const times = reading.map((sample) => recordedAtOf(sample, now));
    if (times.some((time) => time === null) || reading.some((sample) => typeof sample.externalId !== 'string' || !sample.externalId)) {
      skip('invalid');
      continue;
    }
    if (erasedAt !== null && Date.parse(reading[0].measuredAt) < erasedAt) { skip('erased'); continue; }

    if (reading.length === 1 && reading[0].metricType === 'height') {
      if (heightFault(reading[0].value)) skip('invalid');
      else height = reading[0];
      continue;
    }
    // A pair is one systolic and one diastolic. Health shows only the half the
    // person allowed, and half a reading is not a blood pressure.
    const halves = reading.map((sample) => sample.metricType).sort().join();
    if (typeof reading[0].pairId === 'string' && halves !== 'diastolic_bp,systolic_bp') { skip('invalid'); continue; }
    if (reading.some((sample) => !(METRIC_TYPES as readonly string[]).includes(sample.metricType) || measurementValueFault(sample.metricType, sample.value))) {
      skip('invalid');
      continue;
    }

    // Every half must be free to land before any does.
    const places = reading.map((sample, i) => {
      const recordedAt = times[i] as string;
      const key = slotKey('measurement', sample.metricType, recordedAt);
      const heldAt = activeAt.get(key);
      return { sample, recordedAt, key, heldAt, held: heldAt === undefined ? undefined : measurements[heldAt] };
    });
    if (places.some(({ held }) => held && held.source !== source)) { skip('held'); continue; }
    if (places.some(({ held, recordedAt }) => held && Date.parse(held.recordedAt) >= Date.parse(recordedAt))) { skip('earlier'); continue; }

    for (const { sample, recordedAt, key, heldAt, held } of places) {
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
