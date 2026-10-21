// Blood pressure as one reading on the phone (US-25 AC17). The record keeps
// two rows, systolic_bp and diastolic_bp, on the same day, as the web's vitals
// matrix pairs them (StartingInfoVitals.tsx). This file writes both or
// neither, and reads them back as pairs.
import type { FileMeasurement, RoadmapFile } from '../../packages/health-core/src/roadmap-file';
import { appendMeasurement, correctValue, findActiveInSlot, resolveRecordedAt } from '../../packages/health-core/src/record-edits';
import { latestActivePerMetric } from '../../packages/health-core/src/measurement-history';
import { formatDisplayValue } from '../../packages/health-core/src/units';
import type { HistoryRow, MetricHistory } from './my-data-forms';

/** The phone's name for the pair; no row carries it. */
export const BLOOD_PRESSURE = 'blood_pressure';
const HALVES = ['systolic_bp', 'diastolic_bp'] as const;
const UNIT = 'mmHg';

export interface PressureEdit {
  kind: 'bloodPressure';
  systolic: number;
  diastolic: number;
  /** YYYY-MM-DD */
  day: string;
  /** The user agreed to replace what the day holds: each changed half becomes a correction. */
  replace?: boolean;
}

type Outcome =
  | { ok: true; file: RoadmapFile }
  | { ok: false; reason: string; message: string; existingId?: string };

/**
 * Both halves, or neither. Each half is health-core's own write
 * (`appendMeasurement`, or `correctValue` when replacing), applied to the
 * record in turn; the first refusal returns, and the record given is never
 * changed, so a refused half leaves nothing behind.
 */
export function applyPressure(file: RoadmapFile, edit: PressureEdit, now: string): Outcome {
  const values = [edit.systolic, edit.diastolic];
  if (!values.every((value) => typeof value === 'number' && Number.isFinite(value))) {
    return { ok: false, reason: 'invalid-value', message: 'A blood pressure needs both numbers.' };
  }
  const day = resolveRecordedAt(edit.day, { now });
  if (typeof day !== 'string') return day;
  // Ask before touching a day that holds either half, so a free half is never written alone.
  const held = HALVES.map((metric) => findActiveInSlot(file, 'measurement', metric, day));
  const taken = held.find((row) => row !== undefined);
  if (taken && !edit.replace) {
    return { ok: false, reason: 'slot-occupied', message: `Blood pressure already has a value on ${day}.`, existingId: taken.id };
  }
  // The exact pair the day already holds writes nothing.
  if (held.every((row, index) => row && Math.abs(row.value - values[index]) < 1e-9)) return { ok: true, file };
  // Otherwise every held half is corrected, an unchanged one too, so the history
  // keeps whole pairs: the struck pair reads 120/80, never 120/– (orchestrator, 2026-10-22).
  let next = file;
  for (const [index, metricType] of HALVES.entries()) {
    const old = held[index];
    const result = old
      ? correctValue(next, { id: old.id, newValue: values[index], unit: UNIT, now })
      : appendMeasurement(next, { metricType, value: values[index], unit: UNIT, recordedAt: day, now });
    if (!result.ok) return { ok: false, reason: result.reason, message: result.message };
    next = result.file;
  }
  return { ok: true, file: next };
}

/**
 * Every blood pressure, newest day first, as pairs: each day's active pair,
 * then the pairs it replaced, grouped by the write that made them (rows written
 * together share `createdAt`). A missing half shows as a dash.
 */
export function pressureHistory(file: RoadmapFile, excludedFields: readonly string[]): MetricHistory {
  const rows = file.measurements.filter((row) => (HALVES as readonly string[]).includes(row.metricType));
  const current = new Set(latestActivePerMetric(rows).map((row) => row.id));
  const days = [...new Set(rows.map((row) => row.recordedAt.slice(0, 10)))].sort().reverse();
  const pairs: HistoryRow[] = [];
  for (const day of days) {
    const onDay = rows.filter((row) => row.recordedAt.slice(0, 10) === day);
    const active = latestActivePerMetric(onDay);
    if (active.length > 0) {
      pairs.push(pair(active, 'active', active.some((row) => current.has(row.id))));
    }
    const replaced = onDay.filter((row) => row.status !== 'active');
    const writes = [...new Set(replaced.map((row) => String(row.createdAt ?? '')))].sort().reverse();
    for (const write of writes) {
      pairs.push(pair(replaced.filter((row) => String(row.createdAt ?? '') === write), 'entered-in-error', false));
    }
  }
  return {
    metric: BLOOD_PRESSURE,
    label: 'Blood pressure',
    unit: UNIT,
    excluded: excludedFields.includes('systolicBp') || excludedFields.includes('diastolicBp'),
    rows: pairs,
  };
}

function pair(rows: FileMeasurement[], status: HistoryRow['status'], isCurrent: boolean): HistoryRow {
  const half = (metric: string) => {
    const row = rows.find((r) => r.metricType === metric);
    return row ? formatDisplayValue(metric as 'systolic_bp', row.value, 'si') : null;
  };
  const systolic = half('systolic_bp');
  const diastolic = half('diastolic_bp');
  return {
    id: rows[0].id,
    value: `${systolic ?? '–'}/${diastolic ?? '–'}`,
    systolic,
    diastolic,
    day: rows[0].recordedAt.slice(0, 10),
    status,
    current: isCurrent,
    correction: rows.some((row) => !!row.correctsId),
  };
}
