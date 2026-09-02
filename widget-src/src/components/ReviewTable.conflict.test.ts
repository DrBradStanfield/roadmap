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

const build = (results: FileResult[], bloodTests: ApiMeasurement[], labValues: ApiLabValue[] = []) =>
  buildMatrixModel(results, { 0: DATE }, bloodTests, labValues, 'si');

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
