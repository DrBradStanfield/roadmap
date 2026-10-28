/**
 * The values a person entered, as writes to a device's health store (Apple
 * Health on the iPhone): US-25 AC14, ios/architecture.md D6 (Brad 2026-10-21).
 *
 * - Only each slot's ACTIVE row is written; a replaced value is not.
 * - A row that came from the store is never written back, nor any correction
 *   of one (judged by the root of its chain): the store already holds that
 *   reading, and a second copy would be read again as a new one.
 * - Each write is keyed by the root id of its correction chain, with the
 *   chain's length as a rising version (a write clock can go back; a chain only
 *   grows; Codex review 2026-10-21). The store keeps one sample
 *   per key and replaces it when the version rises, so a correction replaces
 *   the sample instead of adding a second.
 * - Blood pressure is one reading in a store (systolic over diastolic): the
 *   day's two halves are written together, keyed by the systolic chain, once
 *   both are there and neither came from the store.
 * - Only the vitals a store holds. Blood tests are not quantity samples there.
 */
import { dayOf } from './merge';
import type { FileMeasurement, RoadmapFile } from './roadmap-file';
import type { MeasurementSource } from './validation';

export interface DeviceWrite {
  /** The root id of the correction chain: the same for every correction of one value. */
  syncId: string;
  /** Rises with each correction: the chain's length (both chains' for a blood pressure). */
  version: number;
  /** YYYY-MM-DD: the day the value is for. */
  day: string;
  /** SI canonical values by metric: one metric, or both halves of a blood pressure. */
  values: Record<string, number>;
}

const SINGLE_METRICS = new Set(['weight', 'waist']);

export function deviceWrites(file: RoadmapFile, source: MeasurementSource): DeviceWrite[] {
  const byId = new Map(file.measurements.map((row) => [row.id, row]));
  /** The first row of the chain `row` ends, following `correctsId` back, and the chain's length. */
  const chainOf = (row: FileMeasurement): { root: FileMeasurement; length: number } => {
    let root = row;
    let length = 1;
    // A chain is short; the bound only stops a hand-made cycle.
    for (; root.correctsId && length < 1000; length++) {
      const previous = byId.get(root.correctsId);
      if (!previous) break;
      root = previous;
    }
    return { root, length };
  };

  type Half = { row: FileMeasurement; length: number };
  const writes: DeviceWrite[] = [];
  const pressure = new Map<string, { systolic?: Half & { root: string }; diastolic?: Half }>();
  /** Days with a store-sourced half: that day's pair is not written at all. */
  const storeDays = new Set<string>();
  for (const row of file.measurements) {
    if (row.status !== 'active') continue;
    const isPressure = row.metricType === 'systolic_bp' || row.metricType === 'diastolic_bp';
    if (!SINGLE_METRICS.has(row.metricType) && !isPressure) continue;
    const { root, length } = chainOf(row);
    const day = dayOf(row.recordedAt);
    if (root.source === source || row.source === source) {
      if (isPressure) storeDays.add(day);
      continue;
    }
    if (!isPressure) {
      writes.push({ syncId: root.id, version: length, day, values: { [row.metricType]: row.value } });
      continue;
    }
    const pair = pressure.get(day) ?? {};
    if (row.metricType === 'systolic_bp') pressure.set(day, { ...pair, systolic: { row, length, root: root.id } });
    else pressure.set(day, { ...pair, diastolic: { row, length } });
  }
  for (const [day, { systolic, diastolic }] of pressure) {
    if (!systolic || !diastolic || storeDays.has(day)) continue;
    writes.push({
      syncId: systolic.root,
      // A correction of either half lengthens its chain, so the sum rises.
      version: systolic.length + diastolic.length,
      day,
      values: { systolic_bp: systolic.row.value, diastolic_bp: diastolic.row.value },
    });
  }
  return writes;
}
