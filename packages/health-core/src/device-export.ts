/**
 * The values a person entered, as writes to a device's health store (Apple
 * Health on the iPhone): US-25 AC9, ios/architecture.md D6 (Brad 2026-10-21).
 *
 * - Only each slot's ACTIVE row is written; a replaced value is not.
 * - A row that came from the store is never written back, nor any correction
 *   of one (judged by the root of its chain): the store already holds that
 *   reading, and a second copy would be read again as a new one.
 * - Each write is keyed by the root id of its correction chain, with the
 *   active row's write time as a rising version. The store keeps one sample
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
  /** Rises with each correction: the active row's `createdAt`, in ms. */
  version: number;
  /** YYYY-MM-DD: the day the value is for. */
  day: string;
  /** SI canonical values by metric: one metric, or both halves of a blood pressure. */
  values: Record<string, number>;
}

const SINGLE_METRICS = new Set(['weight', 'waist']);

export function deviceWrites(file: RoadmapFile, source: MeasurementSource): DeviceWrite[] {
  const byId = new Map(file.measurements.map((row) => [row.id, row]));
  /** The first row of the chain `row` ends, following `correctsId` back. */
  const rootOf = (row: FileMeasurement): FileMeasurement => {
    let root = row;
    // A chain is short; the bound only stops a hand-made cycle.
    for (let steps = 0; root.correctsId && steps < 1000; steps++) {
      const previous = byId.get(root.correctsId);
      if (!previous) break;
      root = previous;
    }
    return root;
  };

  const writes: DeviceWrite[] = [];
  const pressure = new Map<string, { systolic?: FileMeasurement; diastolic?: FileMeasurement; root?: string }>();
  /** Days with a store-sourced half: that day's pair is not written at all. */
  const storeDays = new Set<string>();
  for (const row of file.measurements) {
    if (row.status !== 'active') continue;
    const isPressure = row.metricType === 'systolic_bp' || row.metricType === 'diastolic_bp';
    if (!SINGLE_METRICS.has(row.metricType) && !isPressure) continue;
    const root = rootOf(row);
    const day = dayOf(row.recordedAt);
    if (root.source === source || row.source === source) {
      if (isPressure) storeDays.add(day);
      continue;
    }
    if (!isPressure) {
      writes.push({ syncId: root.id, version: Date.parse(row.createdAt), day, values: { [row.metricType]: row.value } });
      continue;
    }
    const pair = pressure.get(day) ?? {};
    if (row.metricType === 'systolic_bp') pressure.set(day, { ...pair, systolic: row, root: root.id });
    else pressure.set(day, { ...pair, diastolic: row });
  }
  for (const [day, { systolic, diastolic, root }] of pressure) {
    if (!systolic || !diastolic || !root || storeDays.has(day)) continue;
    writes.push({
      syncId: root,
      version: Math.max(Date.parse(systolic.createdAt), Date.parse(diastolic.createdAt)),
      day,
      values: { systolic_bp: systolic.value, diastolic_bp: diastolic.value },
    });
  }
  return writes;
}
