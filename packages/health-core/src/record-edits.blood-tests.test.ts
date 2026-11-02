/**
 * US-66 AC6: every writer puts a blood test in `labValues`. A core value is a
 * core row, converted to its canonical unit and range-checked on that number;
 * an upload's extra creatinine stays a lab row under its printed name.
 */
import { describe, expect, it } from 'vitest';
import { bloodTestRows } from './blood-tests';
import { addLabValues, addMeasurement, readRecord } from './mcp-tools';
import {
  appendLabValue, appendMeasurement, bulkAppendValues, correctValue, findActiveInSlot, moveBloodTest, placeMeasurement,
  planBloodTestMove, slotIndex, slotKey,
} from './record-edits';
import { createEmptyFile, createLabValue, createMeasurement, type FileLabValue, type RoadmapFile } from './roadmap-file';
import { reportedToCanonical } from './units';

const NOW = '2026-09-01T09:00:00Z';
const EDIT = { now: NOW, latestDay: '2026-09-01' };

function core(id: string, metric: string, value: number, recordedAt = '2026-05-01', extra: Partial<FileLabValue> = {}): FileLabValue {
  return { ...createLabValue({ id, metricName: metric, value, unit: metric === 'hba1c' ? 'mmol/mol' : 'mmol/L', recordedAt, createdAt: `${recordedAt}T08:00:00Z`, ...extra }), core: true };
}

function file(labValues: FileLabValue[] = []): RoadmapFile {
  return { ...createEmptyFile({ deviceId: 'd', now: '2026-01-01T00:00:00Z' }), labValues };
}

const ldlSI = (mgdl: number) => reportedToCanonical('ldl', mgdl, 'mg/dL')!.valueSI;

describe('US-66 AC6: appendMeasurement and placeMeasurement', () => {
  it('writes a blood test as a core row in its canonical unit', () => {
    const result = appendMeasurement(file(), { ...EDIT, metricType: 'ldl', value: 100, unit: 'mg/dL', recordedAt: '2026-05-01' });
    if (!result.ok) throw new Error(result.message);
    expect(result.file.measurements).toEqual([]);
    expect(result.file.labValues).toEqual([result.row]);
    expect(result.row).toMatchObject({ metricName: 'ldl', unit: 'mmol/L', core: true, referenceLow: null, referenceHigh: null, recordedAt: '2026-05-01', createdAt: NOW });
    expect(result.row.value).toBeCloseTo(ldlSI(100), 9);
  });

  it('range-checks the converted value and refuses a held day', () => {
    expect(appendMeasurement(file(), { ...EDIT, metricType: 'hba1c', value: 900 })).toMatchObject({ ok: false, reason: 'out-of-range' });
    const held = file([core('h', 'ldl', 3, '2026-05-01')]);
    expect(appendMeasurement(held, { ...EDIT, metricType: 'ldl', value: 3.3, recordedAt: '2026-05-01' })).toMatchObject({ ok: false, reason: 'slot-occupied', existing: { id: 'h' } });
  });

  it('leaves vitals in measurements', () => {
    const result = appendMeasurement(file(), { ...EDIT, metricType: 'weight', value: 80 });
    if (!result.ok) throw new Error(result.message);
    expect(result.file.measurements).toEqual([result.row]);
    expect(result.file.labValues).toEqual([]);
  });

  it('placeMeasurement (the web form) writes a core row too', () => {
    const result = placeMeasurement(file(), { metricType: 'hba1c', value: 40, recordedAt: '2026-05-01', now: NOW });
    if (!result.ok) throw new Error(result.message);
    expect(result.file.labValues[0]).toMatchObject({ metricName: 'hba1c', unit: 'mmol/mol', core: true, value: 40 });
  });

  it('one slot vocabulary: a blood metric asked as a measurement finds its core row', () => {
    const held = file([core('h', 'ldl', 3, '2026-05-01T07:00:00Z')]);
    expect(findActiveInSlot(held, 'measurement', 'ldl', '2026-05-01')?.id).toBe('h');
    expect(slotIndex(held).get(slotKey('measurement', 'ldl', '2026-05-01'))?.id).toBe('h');
    // An unflagged lab row named "LDL" holds a different slot.
    const extra = file([createLabValue({ id: 'x', metricName: 'LDL', value: 3, unit: 'mmol/L', recordedAt: '2026-05-01', createdAt: NOW })]);
    expect(findActiveInSlot(extra, 'measurement', 'ldl', '2026-05-01')).toBeUndefined();
  });
});

describe('US-66 AC6: appendLabValue takes core names', () => {
  it('writes "LDL Cholesterol" in mg/dL as the core LDL, bounds converted', () => {
    const result = appendLabValue(file(), { ...EDIT, metricName: 'LDL Cholesterol', value: 100, unit: 'mg/dL', referenceHigh: 130, recordedAt: '2026-05-01' });
    if (!result.ok) throw new Error(result.message);
    expect(result.row).toMatchObject({ metricName: 'ldl', unit: 'mmol/L', core: true, referenceLow: null });
    expect(result.row.value).toBeCloseTo(ldlSI(100), 9);
    expect(result.row.referenceHigh).toBeCloseTo(ldlSI(130), 9);
    expect(bloodTestRows(result.file).map((r) => r.id)).toEqual([result.row.id]);
  });

  it('a creatinine typed by name is a core value (an agent or the CLI typing it)', () => {
    const result = appendLabValue(file(), { ...EDIT, metricName: 'creatinine', value: 80, unit: 'umol/L' });
    if (!result.ok) throw new Error(result.message);
    expect(result.row).toMatchObject({ metricName: 'creatinine', unit: 'µmol/L', value: 80, core: true });
  });

  it('refuses a unit the test does not take, an out-of-range value and a held day', () => {
    expect(appendLabValue(file(), { ...EDIT, metricName: 'LDL', value: 3, unit: 'mmol' })).toMatchObject({ ok: false, reason: 'unknown-unit' });
    expect(appendLabValue(file(), { ...EDIT, metricName: 'HbA1c', value: 900, unit: 'mmol/mol' })).toMatchObject({ ok: false, reason: 'out-of-range' });
    const held = file([core('h', 'ldl', 3, '2026-05-01')]);
    expect(appendLabValue(held, { ...EDIT, metricName: 'LDL-C', value: 3.1, unit: 'mmol/L', recordedAt: '2026-05-01' })).toMatchObject({ ok: false, reason: 'slot-occupied', existing: { id: 'h' } });
  });

  it('keeps the refusals for vitals and height', () => {
    expect(appendLabValue(file(), { ...EDIT, metricName: 'Weight', value: 80, unit: 'kg' })).toMatchObject({ ok: false, reason: 'core-metric' });
    expect(appendLabValue(file(), { ...EDIT, metricName: 'Height', value: 180, unit: 'cm' })).toMatchObject({ ok: false, reason: 'core-metric' });
  });
});

describe('US-66 AC6: correctValue on a core row', () => {
  it('converts a given unit, keeps the flag and the canonical unit, and flips the old row', () => {
    const start = file([core('h', 'ldl', 3, '2026-05-01')]);
    const result = correctValue(start, { ...EDIT, id: 'h', newValue: 120, unit: 'mg/dL', expectedValue: 3 });
    if (!result.ok) throw new Error(result.message);
    expect(result.row).toMatchObject({ metricName: 'ldl', unit: 'mmol/L', core: true, correctsId: 'h', recordedAt: '2026-05-01' });
    expect(result.row.value).toBeCloseTo(ldlSI(120), 9);
    expect(result.file.labValues.find((r) => r.id === 'h')!.status).toBe('entered-in-error');
    expect(result.file.measurements).toEqual([]);
  });

  it('range-checks the corrected value and keeps the expectedValue check', () => {
    const start = file([core('h', 'hba1c', 40)]);
    expect(correctValue(start, { ...EDIT, id: 'h', newValue: 900 })).toMatchObject({ ok: false, reason: 'out-of-range' });
    expect(correctValue(start, { ...EDIT, id: 'h', newValue: 41, expectedValue: 39 })).toMatchObject({ ok: false, reason: 'value-changed' });
    expect(correctValue(start, { ...EDIT, id: 'h', newValue: 41, unit: 'kg' })).toMatchObject({ ok: false, reason: 'unknown-unit' });
  });
});

describe('US-66 AC6: bulkAppendValues (the upload and import_documents)', () => {
  it('writes a core measurement as a core row', () => {
    const out = bulkAppendValues(file(), [{ kind: 'measurement', metricType: 'ldl', value: 3.1, recordedAt: '2026-05-01', source: 'lab_import' }], NOW);
    expect(out.file.measurements).toEqual([]);
    expect(out.saved[0]).toMatchObject({ metricName: 'ldl', unit: 'mmol/L', core: true, value: 3.1, source: 'lab_import' });
  });

  it('D5: an extra value named like a core test other than creatinine is the core value, converted', () => {
    const out = bulkAppendValues(file(), [{ kind: 'lab', metricName: 'LDL Cholesterol', value: 100, unit: 'mg/dL', referenceHigh: 130, recordedAt: '2026-05-01', source: 'lab_import' }], NOW);
    expect(out.saved).toHaveLength(1);
    expect(out.saved[0]).toMatchObject({ metricName: 'ldl', unit: 'mmol/L', core: true });
    expect(out.saved[0].value).toBeCloseTo(ldlSI(100), 9);
  });

  it('D5: on a held day it is skipped unless it replaces, and a replacement corrects the core row', () => {
    const held = file([core('h', 'ldl', 3, '2026-05-01')]);
    const row = { kind: 'lab' as const, metricName: 'LDL-C', value: 3.4, unit: 'mmol/L', recordedAt: '2026-05-01', source: 'lab_import' as const };
    expect(bulkAppendValues(held, [row], NOW)).toMatchObject({ saved: [], skippedDuplicates: 1 });
    const replaced = bulkAppendValues(held, [{ ...row, correctsId: 'h' }], NOW);
    expect(replaced.saved[0]).toMatchObject({ metricName: 'ldl', core: true, value: 3.4, correctsId: 'h' });
    expect(replaced.file.labValues.find((r) => r.id === 'h')!.status).toBe('entered-in-error');
  });

  it('D5: a unit that will not convert is refused with its reason, an out-of-range value too; never a quiet lab row', () => {
    const out = bulkAppendValues(file(), [
      { kind: 'lab', metricName: 'LDL', value: 3, unit: 'mmol', recordedAt: '2026-05-01', source: 'lab_import' },
      { kind: 'lab', metricName: 'HbA1c', value: 900, unit: 'mmol/mol', recordedAt: '2026-05-01', source: 'lab_import' },
    ], NOW);
    expect(out.saved).toEqual([]);
    expect(out.file.labValues).toEqual([]);
    expect(out.refused).toEqual([expect.objectContaining({ key: 'ldl', unit: 'mmol' })]);
    expect(out.refused[0].message).toContain('mmol');
    expect(out.measurementRefusals).toEqual([expect.objectContaining({ index: 1, metricType: 'hba1c', reason: 'out-of-range', bound: 'above' })]);
  });

  it('US-12 AC11: an extra creatinine stays a lab row under its printed name', () => {
    const out = bulkAppendValues(file(), [{ kind: 'lab', metricName: 'Creatinine', value: 9, unit: 'mmol/L', recordedAt: '2026-05-01', source: 'lab_import' }], NOW);
    expect(out.saved).toHaveLength(1);
    expect(out.saved[0]).toMatchObject({ metricName: 'Creatinine', unit: 'mmol/L', value: 9 });
    expect('core' in out.saved[0]).toBe(false);
  });
});

describe('US-66 AC6 / US-04 AC5: moving a blood test moves its core rows', () => {
  it('plans and moves a core row with its flag', () => {
    const start = { ...file([core('c', 'ldl', 3, '2024-03-12')]), measurements: [createMeasurement({ id: 'w', metricType: 'weight', value: 80, recordedAt: '2024-03-12', createdAt: NOW })] };
    const plan = planBloodTestMove(start, '2024-03-12', '2024-02-21', EDIT);
    if (!('rows' in plan)) throw new Error(plan.message);
    expect(plan.rows.map((r) => r.id)).toEqual(['c']);
    const moved = moveBloodTest(start, { ...EDIT, from: '2024-03-12', to: '2024-02-21', expectedIds: ['c'], keep: {} });
    if (!moved.ok) throw new Error(moved.message);
    expect(moved.rows[0]).toMatchObject({ metricName: 'ldl', core: true, recordedAt: '2024-02-21', correctsId: 'c' });
    expect(moved.file.measurements[0].status).toBe('active');
  });

  it('a held core value on the new day is a clash', () => {
    const start = file([core('c', 'ldl', 3, '2024-03-12'), core('t', 'ldl', 3.5, '2024-02-21')]);
    const plan = planBloodTestMove(start, '2024-03-12', '2024-02-21', EDIT) as { clashes: Array<{ held: { id: string } }> };
    expect(plan.clashes.map((c) => c.held.id)).toEqual(['t']);
  });
});

describe('US-66 AC11: the agent tools', () => {
  const ctx = { now: NOW, latestDay: '2026-09-01' };

  it('add_measurement writes a core row and answers with its metric', () => {
    const outcome = addMeasurement(file(), { metricType: 'ldl', value: 3.1, recordedAt: '2026-05-01' }, ctx);
    expect(outcome).toMatchObject({ status: 'ok', data: { metricType: 'ldl', value: 3.1, unit: 'mmol/L' } });
    if (outcome.status === 'ok') expect(outcome.file!.labValues[0]).toMatchObject({ core: true });
  });

  it('add_lab_values accepts a core name', () => {
    const outcome = addLabValues(file(), { values: [{ metricName: 'HbA1c', value: 6, unit: '%', recordedAt: '2026-05-01' }] }, ctx);
    expect(outcome).toMatchObject({ status: 'ok' });
    if (outcome.status === 'ok') expect(outcome.file!.labValues[0]).toMatchObject({ metricName: 'hba1c', unit: 'mmol/mol', core: true });
  });

  it('read_record marks the current core row and filters on the metric', () => {
    const start = file([
      core('old', 'ldl', 3, '2026-04-01'),
      core('new', 'ldl', 3.2, '2026-05-01'),
      createLabValue({ id: 'x', metricName: 'LDL', value: 9, unit: 'mmol/L', recordedAt: '2026-06-01', createdAt: NOW }),
    ]);
    const outcome = readRecord(start, { metric: 'ldl' });
    if (outcome.status !== 'ok') throw new Error(outcome.text);
    const rows = (outcome.data as { labValues: Array<{ id: string; current: boolean }> }).labValues;
    expect(rows.find((r) => r.id === 'new')!.current).toBe(true);
    expect(rows.find((r) => r.id === 'old')!.current).toBe(false);
    // The unflagged extra row is current in its own slot, apart from the core one.
    expect(rows.find((r) => r.id === 'x')!.current).toBe(true);
  });
});
