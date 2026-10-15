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
