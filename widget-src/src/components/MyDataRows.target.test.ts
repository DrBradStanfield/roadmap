// H83: a My health row with no value prints its target with its unit
// (health-core rowTarget's `alone`, "Optimal <1.4 mmol/L"); a row with a value
// keeps the unitless `bare`, since the unit is printed under the value.
import { describe, expect, it } from 'vitest';
import type { ApiMeasurement } from '@roadmap/health-core/mappings';
import { coreRow, pressureRow, type RowContext } from './MyDataRows';

const plan = { age: 50, idealBodyWeight: 70, heightCm: 178 };
const si: RowContext = { grading: {}, plan, unitOf: () => 'si' };
const us: RowContext = { grading: {}, plan, unitOf: () => 'conventional' };
const at = '2026-10-01T09:00:00.000Z';
const value = (metricType: string, v: number, comparator?: '<'): ApiMeasurement =>
  ({ id: `m-${metricType}`, metricType, value: v, recordedAt: at, createdAt: at, ...(comparator ? { comparator } : {}) });

describe('MyDataRows: a target alone carries its unit (H83)', () => {
  it('an empty row prints the target with the unit, SI and US', () => {
    expect(coreRow('ldl', [], si)).toMatchObject({ latest: null, target: 'Optimal <1.4 mmol/L' });
    expect(coreRow('weight', [], si)).toMatchObject({ latest: null, target: 'Target 70.0 kg' });
    expect(coreRow('waist', [], si)).toMatchObject({ latest: null, target: 'Target <89 cm' });
    expect(pressureRow([], si)).toMatchObject({ latest: null, target: 'Target <120/80 mmHg' });
    expect(coreRow('ldl', [], us)).toMatchObject({ latest: null, target: 'Optimal <55 mg/dL' });
    expect(coreRow('hba1c', [], us)).toMatchObject({ latest: null, target: 'Normal <5.7%' });
  });

  it('a row with a value keeps the bare target, the unit under the value', () => {
    expect(coreRow('ldl', [value('ldl', 3.4)], si)).toMatchObject({ latest: '3.4', unit: 'mmol/L', target: 'Optimal <1.4' });
    const bp = [value('systolic_bp', 121), { ...value('diastolic_bp', 79), id: 'm-dia' }];
    expect(pressureRow(bp, si)).toMatchObject({ latest: '121/79', unit: 'mmHg', target: 'Target <120/80' });
  });

  it('a record with only limit waists ("<80") shows the value and a bare target: no doubled cm', () => {
    const waist = coreRow('waist', [value('waist', 80, '<')], si);
    expect(waist.latest).toMatch(/80/);
    expect(waist).toMatchObject({ unit: 'cm', target: 'Target <89' });
  });
});
