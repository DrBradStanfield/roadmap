/**
 * US-12 AC20: a lab limit is written as an immutable row with its comparator;
 * a correction is an exact value; a move keeps the limit; Apple Health never
 * gets one.
 */
import { describe, expect, it } from 'vitest';
import { bulkAppendValues, correctValue, moveBloodTest, sameLabQuantity } from './record-edits';
import { createEmptyFile, type FileLabValue, type FileMeasurement } from './roadmap-file';
import { deviceWrites } from './device-export';
import { readableView } from './readable-rows';

const NOW = '2026-10-21T08:00:00.000Z';
const empty = () => createEmptyFile({ deviceId: 'limits', now: '2026-10-01T00:00:00.000Z' });

function saved() {
  const result = bulkAppendValues(empty(), [
    { kind: 'measurement', metricType: 'lpa', value: 10, comparator: '<', recordedAt: '2026-10-10', source: 'lab_import' },
    { kind: 'measurement', metricType: 'hdl', value: 1.4, recordedAt: '2026-10-10', source: 'lab_import' },
    { kind: 'lab', metricName: 'egfr', value: 60, unit: 'mL/min/1.73m²', comparator: '>', recordedAt: '2026-10-10', source: 'lab_import' },
    { kind: 'lab', metricName: 'folate', value: 45, unit: 'nmol/L', comparator: '>', recordedAt: '2026-10-10', source: 'lab_import' },
  ], NOW);
  return result.file;
}

describe('US-12 AC20: writing a limit', () => {
  it('the bulk save keeps each comparator on its row, and writes none on an exact value', () => {
    const file = saved();
    expect(file.measurements.map((m) => [m.metricType, m.value, m.comparator])).toEqual([['lpa', 10, '<'], ['hdl', 1.4, undefined]]);
    expect('comparator' in file.measurements[1]).toBe(false);
    expect(file.labValues.map((l) => [l.metricName, l.value, l.comparator])).toEqual([['egfr', 60, '>'], ['folate', 45, '>']]);
  });

  it('a correction of a limit is an exact value: the old row flips, the new one carries no comparator', () => {
    for (const pick of [(f: ReturnType<typeof saved>) => f.measurements[0] as FileMeasurement | FileLabValue, (f: ReturnType<typeof saved>) => f.labValues[0]]) {
      const file = saved();
      const old = pick(file);
      const result = correctValue(file, { id: old.id, newValue: 12, now: NOW });
      if (!result.ok) throw new Error(result.message);
      expect(result.row.comparator).toBeUndefined();
      expect('comparator' in result.row).toBe(false);
      expect(result.row.correctsId).toBe(old.id);
      const flipped = [...result.file.measurements, ...result.file.labValues].find((r) => r.id === old.id)!;
      expect(flipped).toMatchObject({ status: 'entered-in-error', comparator: old.comparator });
    }
  });

  it('a moved blood test keeps each limit', () => {
    const file = saved();
    const moved = moveBloodTest(file, {
      from: '2026-10-10', to: '2026-10-08', now: NOW, keep: {},
      expectedIds: [...file.measurements, ...file.labValues].map((r) => r.id),
    });
    if (!moved.ok) throw new Error(moved.message);
    expect(moved.rows.map((r) => r.comparator)).toEqual(['<', undefined, '>', '>']);
  });

  it('a limit and an exact value of one number are never the same result', () => {
    const exact = { name: 'folate', value: 45, unit: 'nmol/L' };
    expect(sameLabQuantity(exact, { ...exact, comparator: '>' })).toBe(false);
    expect(sameLabQuantity({ ...exact, comparator: '>' }, { ...exact, comparator: '>' })).toBe(true);
  });
});

describe('US-12 AC20: never to Apple Health', () => {
  it('a vital or blood pressure half printed as a limit is not written, and its day\'s pair is not either', () => {
    const result = bulkAppendValues(empty(), [
      { kind: 'measurement', metricType: 'weight', value: 150, comparator: '>', recordedAt: '2026-10-10', source: 'lab_import' },
      { kind: 'measurement', metricType: 'systolic_bp', value: 120, comparator: '<', recordedAt: '2026-10-10', source: 'lab_import' },
      { kind: 'measurement', metricType: 'diastolic_bp', value: 70, recordedAt: '2026-10-10', source: 'lab_import' },
      { kind: 'measurement', metricType: 'weight', value: 80, recordedAt: '2026-10-11', source: 'lab_import' },
    ], NOW);
    expect(deviceWrites(result.file, 'apple_health').map((w) => w.values)).toEqual([{ weight: 80 }]);
  });

  it('any comparator key keeps a row out, valid or not (null, "", 0, "≥"), with its blood pressure pair', () => {
    for (const comparator of [null, '', 0, '≥']) {
      const result = bulkAppendValues(empty(), [
        { kind: 'measurement', metricType: 'weight', value: 80, recordedAt: '2026-10-10', source: 'lab_import' },
        { kind: 'measurement', metricType: 'systolic_bp', value: 120, recordedAt: '2026-10-10', source: 'lab_import' },
        { kind: 'measurement', metricType: 'diastolic_bp', value: 70, recordedAt: '2026-10-10', source: 'lab_import' },
      ], NOW);
      const file = { ...result.file, measurements: result.file.measurements.map((m) => (m.metricType === 'systolic_bp' || m.metricType === 'weight' ? { ...m, comparator } : m)) } as typeof result.file;
      expect(deviceWrites(file, 'apple_health'), String(comparator)).toEqual([]);
    }
  });
});

// Adversary review of 0a2b89b0 (R1): a build before AC20 corrected a lab row by
// copying it, so "> 60" corrected to 85 was written as "> 85". Readers repair it.
describe('US-12 AC20: an older build\'s correction of a limit is read as exact', () => {
  const lab = (id: string, value: number, extra: Record<string, unknown> = {}) => ({
    id, metricName: 'egfr', value, unit: 'mL/min/1.73m²', referenceLow: null, referenceHigh: null,
    recordedAt: '2026-10-10', createdAt: NOW, source: 'lab_import', status: 'active', correctsId: null, ...extra,
  });
  const fileWith = (...rows: ReturnType<typeof lab>[]) => ({ ...empty(), labValues: rows } as unknown as ReturnType<typeof empty>);

  it('a manual correction that changed the value and kept the comparator reads without it; the file is unchanged', () => {
    const file = fileWith(lab('a', 60, { comparator: '>', status: 'entered-in-error' }), lab('b', 85, { comparator: '>', correctsId: 'a', source: 'manual_correction' }));
    const view = readableView(file);
    expect(view.file.labValues.find((l) => l.id === 'b')).not.toHaveProperty('comparator');
    expect(view.count).toBe(0);
    expect(file.labValues[1].comparator).toBe('>');
  });

  it('a move (same value) and an import\'s Replace (lab_import) keep their comparator', () => {
    const moved = fileWith(lab('a', 60, { comparator: '>', status: 'entered-in-error' }), lab('b', 60, { comparator: '>', correctsId: 'a', source: 'manual_correction', recordedAt: '2026-10-08' }));
    expect(readableView(moved).file.labValues.find((l) => l.id === 'b')?.comparator).toBe('>');
    const replaced = fileWith(lab('a', 75, { status: 'entered-in-error' }), lab('b', 60, { comparator: '>', correctsId: 'a' }));
    expect(readableView(replaced).file.labValues.find((l) => l.id === 'b')?.comparator).toBe('>');
  });
});
