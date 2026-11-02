// US-25 AC14 (ios/architecture.md D6): the values a person typed go to the
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

  // US-25 AC14b: a row the save path would refuse (a damaged file, another device's
  // bug, a hand edit) never reaches the store, where other apps read it.
  describe('never writes a value the save path would refuse (US-25 AC14b)', () => {
    /** A typed row whose value was changed afterwards, as a damaged file holds it. */
    function planted(metricType: string, value: number, day = '2026-10-20', file = empty()): RoadmapFile {
      const typed = add(file, metricType, metricType === 'diastolic_bp' ? 80 : metricType === 'systolic_bp' ? 120 : 80, day);
      const last = typed.measurements.length - 1;
      return { ...typed, measurements: typed.measurements.map((row, i) => (i === last ? { ...row, value } : row)) };
    }

    it.each([
      ['a 1e308 kg weight', 'weight', 1e308],
      ['a -5 kg weight', 'weight', -5],
      ['a NaN weight', 'weight', Number.NaN],
      ['an infinite weight', 'weight', Number.POSITIVE_INFINITY],
      ['a negative infinite waist', 'waist', Number.NEGATIVE_INFINITY],
      ['a 0 cm waist', 'waist', 0],
    ])('skips %s', (_name, metricType, value) => {
      expect(deviceWrites(planted(metricType, value), 'apple_health')).toEqual([]);
    });

    it('skips a blood pressure whose either half is out of range, and writes neither half', () => {
      const badTop = planted('systolic_bp', 1e308, '2026-10-20', add(empty(), 'diastolic_bp', 80, '2026-10-20'));
      expect(deviceWrites(badTop, 'apple_health')).toEqual([]);
      const badBottom = planted('diastolic_bp', -5, '2026-10-20', add(empty(), 'systolic_bp', 120, '2026-10-20'));
      expect(deviceWrites(badBottom, 'apple_health')).toEqual([]);
    });

    // The store test runs before the value test, so a bad half from the store still
    // marks its day: that pair is the store's and is never written back.
    it('writes no pressure on a day whose systolic came from Apple Health out of range (US-25 AC14b)', () => {
      const day = '2026-10-21';
      const imported = importDeviceSamples(add(empty(), 'diastolic_bp', 80, day), [
        { externalId: 'hk-sys', metricType: 'systolic_bp', value: 120, measuredAt: '2026-10-21T08:00:00+13:00' },
      ], { now: T1, source: 'apple_health' }).file;
      const bad = { ...imported, measurements: imported.measurements.map((row) => (row.source === 'apple_health' ? { ...row, value: 1e308 } : row)) };
      expect(bad.measurements.map((row) => [row.metricType, row.source])).toEqual([['diastolic_bp', 'manual'], ['systolic_bp', 'apple_health']]);
      expect(deviceWrites(bad, 'apple_health')).toEqual([]);
      // A damaged file that also holds our own systolic that day: still no write.
      const ours = add(add(empty(), 'systolic_bp', 120, day), 'diastolic_bp', 80, day);
      const damaged = { ...ours, measurements: [...ours.measurements, { ...ours.measurements[0], id: 'hk-bad', source: 'apple_health' as const, value: 1e308 }] };
      expect(deviceWrites(damaged, 'apple_health')).toEqual([]);
    });

    // US-02 AC8: a pair the wrong way up (systolic <= diastolic) is no reading,
    // though each half is in range. A damaged file or another device can hold one.
    it.each([[80, 90], [90, 90]])('skips a blood pressure %s/%s, the wrong way up, and writes neither half', (top, bottom) => {
      const day = '2026-10-20';
      const typed = add(add(empty(), 'systolic_bp', 120, day), 'diastolic_bp', 80, day);
      const inverted = { ...typed, measurements: typed.measurements.map((row) => ({ ...row, value: row.metricType === 'systolic_bp' ? top : bottom })) };
      expect(deviceWrites(inverted, 'apple_health')).toEqual([]);
      expect(deviceWrites(typed, 'apple_health')).toHaveLength(1);
    });

    it('still writes the in-range values beside a bad one, unchanged (skipped, never clamped)', () => {
      const file = planted('weight', 1e308, '2026-10-19', add(empty(), 'weight', 80, '2026-10-20'));
      expect(deviceWrites(file, 'apple_health')).toEqual([
        { syncId: file.measurements[0].id, version: 1, day: '2026-10-20', values: { weight: 80 } },
      ]);
    });
  });

  it('writes only the vitals a device store holds, not blood tests', () => {
    const file = add(empty(), 'ldl', 2.5, '2026-10-20');
    expect(deviceWrites(file, 'apple_health')).toEqual([]);
  });
});
