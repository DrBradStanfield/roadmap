import { describe, it, expect } from 'vitest';
import type { ApiMeasurement } from '@roadmap/health-core';
import type { ApiLabValue } from '../lib/api-types';
import { buildMatrixModel } from './ReviewTable';
import type { FileResult } from './ReviewTable';

const DATE = { day: '01', month: '06', year: '2024' };

function history(value: number): ApiMeasurement[] {
  return [{ id: 'old-ldl', metricType: 'ldl', value, recordedAt: '2024-06-01T00:00:00.000Z', createdAt: '2024-06-01T00:00:00.000Z' }];
}

function upload(valueSI: number): FileResult[] {
  return [{
    fileName: 'labs.pdf',
    reportDate: '2024-06-01',
    values: [{ metric: 'ldl', valueSI, displayValue: valueSI, displayUnit: 'mmol/L', confidence: 'high' }],
    additionalValues: [],
  }];
}

const build = (results: FileResult[], measurements: ApiMeasurement[], labValues: ApiLabValue[] = []) =>
  buildMatrixModel(results, { 0: DATE }, measurements, labValues, 'si');

// US-32 · A website upload never silently loses a value to a connector row.
describe('buildMatrixModel slot collision (US-32)', () => {
  it('marks a differing value on an occupied slot with the existing row id — `existing` IS the conflict', () => {
    const { cells } = build(upload(3.2), history(4.5));
    const cell = cells.get('ldl|2024-06-01');
    expect(cell?.state).toBe('editable');
    expect(cell).toMatchObject({ existing: { id: 'old-ldl' } });
    if (cell?.state !== 'editable' || !cell.existing) throw new Error('unreachable');
    expect(cell.existing.display).not.toBe(cell.initialDisplay);
  });

  it('leaves an equal value as already-recorded context — no conflict residue (US-32)', () => {
    const { cells } = build(upload(4.5), history(4.5));
    expect(cells.get('ldl|2024-06-01')).toMatchObject({ state: 'context' });
  });

  it('an empty slot is editable with nothing to replace (US-32)', () => {
    const { cells } = build(upload(3.2), []);
    const cell = cells.get('ldl|2024-06-01');
    expect(cell).toMatchObject({ state: 'editable' });
    expect(cell && 'existing' in cell ? cell.existing : undefined).toBeUndefined();
  });

  // Brad 2026-10-16 (PR #145): the record holds a lab in SI, a report prints its own unit. The website and the
  // connector compare quantities with one rule, health-core's sameLabQuantity (US-35 AC6).
  const lab = (name: string, value: number, unit: string): ApiLabValue => ({
    id: 'held', metricName: name, value, unit, referenceLow: null, referenceHigh: null,
    recordedAt: '2024-06-01T00:00:00.000Z', source: 'manual', createdAt: '2024-06-01T00:00:00.000Z',
  });
  const offered = (name: string, value: number, unit: string): FileResult[] => [{
    fileName: 'labs.pdf', reportDate: '2024-06-01', values: [], additionalValues: [{ name, value, unit }],
  }];
  const labCell = (cells: Map<string, unknown>) => cells.get([...cells.keys()].find(k => k.endsWith('|2024-06-01'))!);

  it('a report spelling and the stored catalogue key share one row, as in the connector (US-35 AC6)', () => {
    // The record files vitamin D as `vitamin_d`; a report prints "Vitamin D". One row, one slot, not two.
    const { additionalRows, cells } = build(offered('Vitamin D', 50, 'nmol/L'), [], [lab('vitamin_d', 50, 'nmol/L')]);
    expect(additionalRows).toHaveLength(1);
    expect(labCell(cells)).toMatchObject({ state: 'context' });
  });

  it('the same number in a different unit is a different result, offered as a conflict (US-35 AC6)', () => {
    const { cells } = build(offered('Vitamin D', 50, 'ng/mL'), [], [lab('vitamin_d', 50, 'nmol/L')]);
    expect(labCell(cells)).toMatchObject({ state: 'editable', existing: { id: 'held' } });
  });

  it('the same quantity printed in another unit is already recorded (US-35 AC6)', () => {
    const { cells } = build(offered('Folate', 20, 'ng/mL'), [], [lab('folate', 45.32, 'nmol/L')]);
    expect(labCell(cells)).toMatchObject({ state: 'context' });
  });

  it('a differing additional lab value on an occupied slot conflicts (US-32)', () => {
    const results: FileResult[] = [{
      fileName: 'labs.pdf', reportDate: '2024-06-01', values: [],
      additionalValues: [{ name: 'Ferritin', value: 95, unit: 'ug/L' }],
    }];
    const labs: ApiLabValue[] = [{
      id: 'old-fer', metricName: 'Ferritin', value: 120, unit: 'ug/L',
      referenceLow: null, referenceHigh: null,
      recordedAt: '2024-06-01T00:00:00.000Z', source: 'manual', createdAt: '2024-06-01T00:00:00.000Z',
    }];
    const { cells } = build(results, [], labs);
    const key = [...cells.keys()].find(k => k.endsWith('|2024-06-01'))!;
    expect(cells.get(key)).toMatchObject({ state: 'editable', existing: { id: 'old-fer', display: '120' } });
  });
});

// US-12 AC11 · every core value the review would save has a row the user sees.
describe('buildMatrixModel shows blood pressure from a lab report (US-12 AC11)', () => {
  it('gives systolic and diastolic BP rows after the blood tests, so save never stores a value nobody saw', () => {
    const results: FileResult[] = [{
      fileName: 'baseline.jpg',
      reportDate: null,
      values: [
        { metric: 'systolic_bp', valueSI: 118, displayValue: 118, displayUnit: 'mmHg', confidence: 'high' },
        { metric: 'diastolic_bp', valueSI: 65, displayValue: 65, displayUnit: 'mmHg', confidence: 'high' },
        { metric: 'ldl', valueSI: 1.51, displayValue: 1.51, displayUnit: 'mmol/L', confidence: 'high' },
      ],
      additionalValues: [],
    }];
    const { coreRows, cells } = build(results, []);
    expect(coreRows.map(r => r.kind === 'core' && r.metric)).toEqual(['ldl', 'systolic_bp', 'diastolic_bp']);
    expect(cells.get('systolic_bp|2024-06-01')).toMatchObject({ state: 'editable', initialDisplay: '118' });
  });
});

describe('buildMatrixModel keeps BP honest against what is saved (US-12 AC11, US-13 AC3)', () => {
  const bp = (valueSI: number): FileResult[] => [{
    fileName: 'baseline.jpg', reportDate: null,
    values: [{ metric: 'systolic_bp', valueSI, displayValue: valueSI, displayUnit: 'mmHg', confidence: 'high' }],
    additionalValues: [],
  }];
  const saved = (metricType: string, value: number, day: string): ApiMeasurement =>
    ({ id: `old-${metricType}-${day}`, metricType, value, recordedAt: `${day}T00:00:00.000Z`, createdAt: `${day}T00:00:00.000Z` });

  it('a saved BP that differs on the upload date is a conflict, not a silent skip', () => {
    const { cells } = build(bp(118), [saved('systolic_bp', 135, '2024-06-01')]);
    expect(cells.get('systolic_bp|2024-06-01')).toMatchObject({ state: 'editable', existing: { id: 'old-systolic_bp-2024-06-01', valueSI: 135 } });
  });

  it('a saved BP on another date adds no column and no row', () => {
    const { columns, coreRows, cells } = build([], [saved('systolic_bp', 135, '2024-01-01'), saved('weight', 80, '2024-01-01')]);
    expect(columns).toEqual([]);
    expect(coreRows).toEqual([]);
    expect(cells.size).toBe(0);
  });

  it('an old lab row named systolic_bp never hides the core value as already saved', () => {
    const labs: ApiLabValue[] = [{
      id: 'lab-sbp', metricName: 'systolic_bp', value: 118, unit: 'mmHg', referenceLow: null, referenceHigh: null,
      recordedAt: '2024-06-01T00:00:00.000Z', source: 'lab_import', createdAt: '2024-06-01T00:00:00.000Z',
    }];
    const { cells } = build(bp(118), [], labs);
    const core = cells.get('systolic_bp|2024-06-01');
    expect(core).toMatchObject({ state: 'editable', kind: 'core' });
    expect(core && 'existing' in core ? core.existing : undefined).toBeUndefined();
  });
});
