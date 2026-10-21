// US-25 AC9 (ios/architecture.md D6): the values a person typed go to the
// device store (Apple Health). Only each slot's active row, never a row that
// came from that store, and keyed by the root of its correction chain with a
// rising version, so a correction replaces the sample instead of adding one.
import { describe, expect, it } from 'vitest';
import { deviceWrites } from './device-export';
import { importDeviceSamples } from './device-import';
import { appendMeasurement, correctValue } from './record-edits';
import { createEmptyFile, type RoadmapFile } from './roadmap-file';

const T1 = '2026-10-21T08:00:00.000Z';
const T2 = '2026-10-21T09:00:00.000Z';

function add(file: RoadmapFile, metricType: string, value: number, day: string, now = T1): RoadmapFile {
  const result = appendMeasurement(file, { metricType, value, recordedAt: day, now });
  if (!result.ok) throw new Error(result.message);
  return result.file;
}

function empty(): RoadmapFile {
  return createEmptyFile({ deviceId: 'phone', now: '2026-10-01T00:00:00.000Z' });
}

describe('deviceWrites', () => {
  it('writes a typed value keyed by its own id, version 1', () => {
    const file = add(empty(), 'weight', 80, '2026-10-20');
    expect(deviceWrites(file, 'apple_health')).toEqual([
      { syncId: file.measurements[0].id, version: 1, day: '2026-10-20', values: { weight: 80 } },
    ]);
  });

  it('keeps the chain\'s root id across a correction, with a higher version and the new value', () => {
    const typed = add(empty(), 'waist', 90, '2026-10-20');
    const corrected = correctValue(typed, { id: typed.measurements[0].id, newValue: 88, now: T2 });
    if (!corrected.ok) throw new Error(corrected.message);
    const again = correctValue(corrected.file, { id: corrected.row.id, newValue: 87, now: '2026-10-21T10:00:00.000Z' });
    if (!again.ok) throw new Error(again.message);
    expect(deviceWrites(again.file, 'apple_health')).toEqual([
      { syncId: typed.measurements[0].id, version: 3, day: '2026-10-20', values: { waist: 87 } },
    ]);
  });

  it('raises the version on a correction even when the phone\'s clock went back', () => {
    const typed = add(empty(), 'weight', 80, '2026-10-20', T2);
    const corrected = correctValue(typed, { id: typed.measurements[0].id, newValue: 79, now: T1 });
    if (!corrected.ok) throw new Error(corrected.message);
    expect(deviceWrites(corrected.file, 'apple_health')[0]).toMatchObject({ version: 2, values: { weight: 79 } });
  });

  it('raises a blood pressure\'s version when either half is corrected', () => {
    let file = add(add(empty(), 'systolic_bp', 128, '2026-10-20'), 'diastolic_bp', 82, '2026-10-20');
    const diastolic = file.measurements[1];
    const corrected = correctValue(file, { id: diastolic.id, newValue: 80, now: T2 });
    if (!corrected.ok) throw new Error(corrected.message);
    file = corrected.file;
    expect(deviceWrites(file, 'apple_health')[0]).toMatchObject({ version: 3, values: { systolic_bp: 128, diastolic_bp: 80 } });
  });

  it('never writes back a row that came from the device store, or a correction of one', () => {
    const imported = importDeviceSamples(empty(), [
      { externalId: 'hk-1', metricType: 'weight', value: 80, measuredAt: '2026-10-21T08:00:00+13:00' },
    ], { now: T1, source: 'apple_health' }).file;
    expect(deviceWrites(imported, 'apple_health')).toEqual([]);
    const corrected = correctValue(imported, { id: imported.measurements[0].id, newValue: 78, now: T2 });
    if (!corrected.ok) throw new Error(corrected.message);
    expect(deviceWrites(corrected.file, 'apple_health')).toEqual([]);
  });

  it('pairs a day\'s blood pressure into one reading, keyed by the systolic chain, and waits for both halves', () => {
    let file = add(empty(), 'systolic_bp', 128, '2026-10-20');
    expect(deviceWrites(file, 'apple_health')).toEqual([]);
    file = add(file, 'diastolic_bp', 82, '2026-10-20', T2);
    expect(deviceWrites(file, 'apple_health')).toEqual([
      { syncId: file.measurements[0].id, version: 2, day: '2026-10-20', values: { systolic_bp: 128, diastolic_bp: 82 } },
    ]);
  });

  it('writes neither half when one half came from the device store', () => {
    let file = add(empty(), 'systolic_bp', 128, '2026-10-21');
    file = importDeviceSamples(file, [
      { externalId: 'hk-dia', metricType: 'diastolic_bp', value: 82, measuredAt: '2026-10-21T08:00:00+13:00' },
    ], { now: T1, source: 'apple_health' }).file;
    expect(deviceWrites(file, 'apple_health')).toEqual([]);
  });

  it('writes only the vitals a device store holds, not blood tests', () => {
    const file = add(empty(), 'ldl', 2.5, '2026-10-20');
    expect(deviceWrites(file, 'apple_health')).toEqual([]);
  });
});
