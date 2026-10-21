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
/** Rows this close together can be one write: the web stamps each half with its own clock. */
const WRITE_MS = 5_000;
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
 * Every blood pressure, newest day first. Each day is replayed (orchestrator,
 * 2026-10-22): its rows, both halves, active or not, in write order, grouped
 * into writes (`writes`); each write sets its halves on the pair and leaves a
 * snapshot. The day's pair now is shown active; every other snapshot is struck,
 * newest first. A row merge set aside (entered in error, no correction naming
 * it) shows over the pair as it stood but never changes it, so a lost write
 * cannot leak into the pair later writes build on. A half not yet written is a dash.
 */
export function pressureHistory(file: RoadmapFile, excludedFields: readonly string[]): MetricHistory {
  const rows = file.measurements.filter((row) => (HALVES as readonly string[]).includes(row.metricType));
  const current = new Set(latestActivePerMetric(rows).map((row) => row.id));
  const days = [...new Set(rows.map((row) => row.recordedAt.slice(0, 10)))].sort().reverse();
  const pairs: HistoryRow[] = [];
  for (const day of days) {
    const onDay = rows.filter((row) => row.recordedAt.slice(0, 10) === day);
    const named = new Set(onDay.map((row) => row.correctsId));
    const lost = (row: FileMeasurement) => row.status !== 'active' && !named.has(row.id);
    let state: Partial<Record<string, FileMeasurement>> = {};
    let stateAt = -1;
    const snapshots: Array<{ id: string; sys?: FileMeasurement; dia?: FileMeasurement; rows: FileMeasurement[] }> = [];
    for (const write of writes(onDay)) {
      const shown = { ...state, ...Object.fromEntries(write.map((row) => [row.metricType, row])) };
      const before = snapshots.at(-1);
      const same = before && before.sys?.value === shown.systolic_bp?.value && before.dia?.value === shown.diastolic_bp?.value;
      // Nothing new: the same values again, written only by rows now set aside.
      if (same && write.every((row) => row.status !== 'active')) continue;
      snapshots.push({ id: write.map((row) => row.id).join('+'), sys: shown.systolic_bp, dia: shown.diastolic_bp, rows: write });
      if (!write.every(lost)) {
        state = shown;
        stateAt = snapshots.length - 1;
      }
    }
    // The pair now: the engine's own slot lookup, the ids a replace must send back (re-check R4).
    const held = HALVES.flatMap((metric) => findActiveInSlot(file, 'measurement', metric, day) ?? []) as FileMeasurement[];
    const shownRow = (index: number): HistoryRow => {
      const now = held.length > 0 && index === stateAt;
      const snapshot = snapshots[index];
      return {
        ...pair(snapshot.sys, snapshot.dia, now ? 'active' : 'entered-in-error', now && held.some((row) => current.has(row.id))),
        id: `${day}:${snapshot.id}`, day, correction: snapshot.rows.some((row) => !!row.correctsId),
        ...(now ? { pairIds: held.map((row) => row.id) } : null),
      };
    };
    // The pair now first, then the struck snapshots newest first.
    const newestFirst = snapshots.map((_, index) => shownRow(index)).reverse();
    pairs.push(...newestFirst.filter((row) => row.status === 'active'), ...newestFirst.filter((row) => row.status !== 'active'));
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

/**
 * The day's rows in write order, grouped into writes. Order: `createdAt`; at a tie,
 * a correction after the row it names (by its depth in the day's chain), then id.
 * A row joins the open write when its half is not there yet, it is within 5 s of
 * the write's first row, and it does not correct a row in the write.
 */
function writes(onDay: FileMeasurement[]): FileMeasurement[][] {
  const byId = new Map(onDay.map((row) => [row.id, row]));
  const depth = (row: FileMeasurement, seen = 0): number => {
    const target = row.correctsId ? byId.get(row.correctsId) : undefined;
    return target && seen < onDay.length ? 1 + depth(target, seen + 1) : 0;
  };
  const ordered = [...onDay].sort((a, b) => createdAt(a).localeCompare(createdAt(b)) || depth(a) - depth(b) || a.id.localeCompare(b.id));
  const found: FileMeasurement[][] = [];
  for (const row of ordered) {
    const open = found.at(-1);
    const joins = open
      && !open.some((r) => r.metricType === row.metricType)
      && Date.parse(createdAt(row)) - Date.parse(createdAt(open[0])) <= WRITE_MS
      && !open.some((r) => r.id === row.correctsId);
    if (joins) open.push(row);
    else found.push([row]);
  }
  return found;
}

function pair(sys: FileMeasurement | undefined, dia: FileMeasurement | undefined, status: HistoryRow['status'], isCurrent: boolean):
  Omit<HistoryRow, 'id' | 'day' | 'correction'> {
  const systolic = sys ? formatDisplayValue('systolic_bp', sys.value, 'si') : null;
  const diastolic = dia ? formatDisplayValue('diastolic_bp', dia.value, 'si') : null;
  return { value: `${systolic ?? '–'}/${diastolic ?? '–'}`, systolic, diastolic, status, current: isCurrent };
}
