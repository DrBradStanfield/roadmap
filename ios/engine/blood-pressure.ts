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
/** Correcting writes this close together are one revision: the web stamps each half with its own clock. */
const REVISION_MS = 5_000;
const CHANGED = 'Your record changed while this was open, so this was not saved. Close this and enter the value again.';

export interface PressureEdit {
  kind: 'bloodPressure';
  systolic: number;
  diastolic: number;
  /** YYYY-MM-DD */
  day: string;
  /** The user agreed to replace what the day holds: each changed half becomes a correction. */
  replace?: boolean;
  /** With `replace`: the ids of the day's active halves the user saw. Any other set refuses. */
  seenIds?: string[];
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
  // A replace names the rows it saw; if another device has moved them since, the
  // user is overwriting a value they never saw (Codex R1, adversary R3).
  if (edit.replace && !sameIds(edit.seenIds, held.flatMap((row) => (row ? [row.id] : [])))) {
    return { ok: false, reason: 'record-changed', message: CHANGED };
  }
  let next = file;
  for (const [index, metricType] of HALVES.entries()) {
    const old = held[index];
    // Only a changed half is corrected. Re-correcting an unchanged one would join
    // merge's last-writer-wins and could undo another device's fix of that half.
    if (old && Math.abs(old.value - values[index]) < 1e-9) continue;
    const result = old
      ? correctValue(next, { id: old.id, newValue: values[index], unit: UNIT, now })
      : appendMeasurement(next, { metricType, value: values[index], unit: UNIT, recordedAt: day, now });
    if (!result.ok) return { ok: false, reason: result.reason, message: result.message };
    next = result.file;
  }
  return { ok: true, file: next };
}

function sameIds(seen: unknown, held: string[]): boolean {
  if (!Array.isArray(seen) || seen.length !== held.length) return false;
  return held.every((id) => seen.includes(id));
}

/**
 * Every blood pressure, newest day first, as pairs: each day's active pair,
 * then one struck pair per revision, newest first. A revision is the correcting
 * writes (rows with `correctsId`) on that day within five seconds of each other,
 * across both halves: the web, CLI and MCP stamp each half with its own clock.
 * Its struck pair shows, for each half, the value active just before it: the row
 * the revision corrected, or for a half it left alone, that half's latest row
 * written by the revision's start. A half the day never held shows as a dash.
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
      const [systolic, diastolic] = HALVES.map((metric) => active.find((row) => row.metricType === metric));
      pairs.push({
        ...pair(systolic, diastolic, 'active', active.some((row) => current.has(row.id))),
        id: active[0].id, day, correction: active.some((row) => !!row.correctsId), pairIds: active.map((row) => row.id),
      });
    }
    for (const revision of revisions(onDay).reverse()) {
      // A half the revision corrected: the row it corrected. A half it left alone:
      // that half's latest row written by the revision's start.
      const before = (metric: string) => {
        const first = revision.rows.find((row) => row.metricType === metric);
        if (first) return onDay.find((row) => row.id === first.correctsId);
        return onDay
          .filter((row) => row.metricType === metric && createdAt(row) <= revision.at)
          .sort((a, b) => createdAt(a).localeCompare(createdAt(b)))
          .at(-1);
      };
      const [systolic, diastolic] = HALVES.map(before);
      pairs.push({ ...pair(systolic, diastolic, 'entered-in-error', false), id: revision.rows[0].id, day, correction: false });
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

const createdAt = (row: FileMeasurement) => String(row.createdAt ?? '');

/** The day's correcting writes, oldest first, grouped into revisions: each starts at its first write. */
function revisions(onDay: FileMeasurement[]): Array<{ at: string; rows: FileMeasurement[] }> {
  const corrections = onDay.filter((row) => !!row.correctsId).sort((a, b) => createdAt(a).localeCompare(createdAt(b)));
  const found: Array<{ at: string; rows: FileMeasurement[] }> = [];
  for (const row of corrections) {
    const open = found.at(-1);
    if (open && Date.parse(createdAt(row)) - Date.parse(open.at) <= REVISION_MS) open.rows.push(row);
    else found.push({ at: createdAt(row), rows: [row] });
  }
  return found;
}

function pair(sys: FileMeasurement | undefined, dia: FileMeasurement | undefined, status: HistoryRow['status'], isCurrent: boolean):
  Omit<HistoryRow, 'id' | 'day' | 'correction'> {
  const systolic = sys ? formatDisplayValue('systolic_bp', sys.value, 'si') : null;
  const diastolic = dia ? formatDisplayValue('diastolic_bp', dia.value, 'si') : null;
  return { value: `${systolic ?? '–'}/${diastolic ?? '–'}`, systolic, diastolic, status, current: isCurrent };
}
