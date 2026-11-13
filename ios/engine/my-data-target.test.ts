// H83: an iPhone My data row with no value prints its target with its unit
// (health-core rowTarget's `alone`, "Optimal <1.4 mmol/L"); a row with a value
// keeps the unitless `bare`, since the unit is printed under the value.
import { describe, expect, it } from 'vitest';
import { applyEdit, myData, newRecord } from './my-data';
import type { RoadmapFile } from '../../packages/health-core/src/roadmap-file';

const NOW = '2026-10-21T08:00:00.000Z';

function edited(file: RoadmapFile, ...edits: Parameters<typeof applyEdit>[1][]): RoadmapFile {
  return edits.reduce((current, edit) => {
    const outcome = applyEdit(current, edit, NOW);
    if (!outcome.ok) throw new Error(outcome.message);
    return outcome.file;
  }, file);
}

const person = (locale: string, zone: string, height = 180) => edited(newRecord(NOW, 'phone', locale, zone),
  { kind: 'profile', sex: 'male', birthYear: 1970, height });
const rows = (file: RoadmapFile) => {
  const data = myData(file, NOW);
  return new Map([...data.vitals, ...data.bloodTests].map((row) => [row.metric, row]));
};

describe('myData rows: a target alone carries its unit (H83)', () => {
  it('an empty row prints the target with the unit, SI and US', () => {
    const si = rows(person('en-NZ', 'Pacific/Auckland'));
    expect(si.get('ldl')).toMatchObject({ latest: null, target: 'Optimal <1.4 mmol/L' });
    expect(si.get('weight')).toMatchObject({ latest: null, target: 'Target 78.0 kg' });
    expect(si.get('waist')).toMatchObject({ latest: null, target: 'Target <90 cm' });
    expect(si.get('blood_pressure')).toMatchObject({ latest: null, target: 'Target <120/80 mmHg' });
    const us = rows(person('en-US', 'America/New_York', 71));
    expect(us.get('ldl')).toMatchObject({ latest: null, target: 'Optimal <55 mg/dL' });
    expect(us.get('hba1c')).toMatchObject({ latest: null, target: 'Normal <5.7%' });
  });

  it('a row with a value keeps the bare target, the unit under the value', () => {
    const shown = rows(edited(person('en-NZ', 'Pacific/Auckland'),
      { kind: 'add', metric: 'ldl', value: 3.4, day: '2026-10-01' },
      { kind: 'bloodPressure', systolic: 121, diastolic: 79, day: '2026-10-02', replace: false }));
    expect(shown.get('ldl')).toMatchObject({ latest: { value: '3.4' }, unit: 'mmol/L', target: 'Optimal <1.4' });
    expect(shown.get('blood_pressure')).toMatchObject({ latest: { value: '121/79' }, unit: 'mmHg', target: 'Target <120/80' });
  });

  it('a record with only limit waists ("<80") shows the value and a bare target: no doubled cm', () => {
    const file = edited(person('en-NZ', 'Pacific/Auckland'), { kind: 'add', metric: 'waist', value: 80, day: '2026-10-01' });
    const limited: RoadmapFile = { ...file, measurements: file.measurements.map((row) => (row.metricType === 'waist' ? { ...row, comparator: '<' } : row)) };
    const waist = rows(limited).get('waist')!;
    expect(waist.latest?.value).toMatch(/80/);
    expect(waist).toMatchObject({ unit: 'cm', target: 'Target <90' });
  });
});
