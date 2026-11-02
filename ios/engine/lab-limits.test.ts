// US-12 AC20 on the phone: a lab result printed as a limit ("< 2", "> 90") is
// saved with its symbol, and every string Swift receives says it as printed.
// The chart gets the bound as a number to plot hollow, and the card's trend
// leaves it out. Synthetic values.
import { describe, expect, it } from 'vitest';
import { applyEdit, myData, newRecord } from './my-data';
import { metricHistory } from './my-data-forms';
import { labReview, labRows } from './lab-review';
import { historyJson, screenJson } from './entry';
import { LIMIT_NOT_GRADED } from '../../packages/health-core/src/lab-limits';
import type { RoadmapFile } from '../../packages/health-core/src/roadmap-file';

const NOW = '2026-10-21T08:00:00.000Z';

const extraction = {
  classification: 'lab_report', reportDate: '2026-10-01',
  values: [
    { metric: 'ldl', valueSI: 2, displayValue: 2, displayUnit: 'mmol/L', displaySystem: 'si', confidence: 'high', comparator: '<' },
    { metric: 'hba1c', valueSI: 40, displayValue: 40, displayUnit: 'mmol/mol', displaySystem: 'si', confidence: 'high' },
  ],
  additionalValues: [
    { name: 'eGFR', value: 90, unit: 'mL/min/1.73m²', comparator: '>' },
    { name: 'CRP', value: 1.2, unit: 'mg/L' },
  ],
};

function edited(file: RoadmapFile, ...edits: Parameters<typeof applyEdit>[1][]): RoadmapFile {
  return edits.reduce((current, edit) => {
    const outcome = applyEdit(current, edit, NOW);
    if (!outcome.ok) throw new Error(outcome.message);
    return outcome.file;
  }, file);
}

/** A record the plan can be made for, with LDL typed on 1 Sept and the report's ticked values saved. */
function withReport(refs = ['v0', 'v1', 'a0', 'a1']): RoadmapFile {
  return edited(newRecord(NOW, 'phone', 'en-NZ', 'Pacific/Auckland'),
    { kind: 'profile', sex: 'male', birthYear: 1966, birthMonth: 1, height: 180 },
    { kind: 'add', metric: 'ldl', value: 3.1, day: '2026-09-01' },
    { kind: 'add', metric: 'ldl', value: 2.9, day: '2026-09-15' },
    { kind: 'labImport', extractionJson: JSON.stringify(extraction), refs, reportDay: '2026-10-01' });
}

describe('US-12 AC20 — lab limits on the phone', () => {
  it('the review shows each limit with its symbol, and an exact value as before', () => {
    const items = labReview(extraction as never, NOW).items;
    expect(items.map((item) => `${item.label}: ${item.value} ${item.unit}`)).toEqual([
      'LDL Cholesterol: < 2 mmol/L',
      'HbA1c: 40 mmol/mol',
      'eGFR: > 90 mL/min/1.73m²',
      'CRP: 1.2 mg/L',
    ]);
  });

  it('the ticked rows carry the code, and only on a limit', () => {
    const rows = labRows(extraction as never, ['v0', 'v1', 'a0', 'a1'], '2026-10-01', NOW);
    expect(rows.ok && rows.rows.map((row) => row.comparator)).toEqual(['<', undefined, '>', undefined]);
    expect(rows.ok && rows.rows.map((row) => 'comparator' in row)).toEqual([true, false, true, false]);
  });

  it('saving writes the limit to the record: the bound in value, the code beside it', () => {
    const file = withReport();
    // LDL and HbA1c are core lab rows (US-66 AC1), each with its own comparator or none.
    const ldl = file.labValues.find((row) => row.core && row.metricName === 'ldl' && row.recordedAt.startsWith('2026-10-01'));
    expect(ldl).toMatchObject({ value: 2, comparator: '<', source: 'lab_import', status: 'active' });
    const hba1c = file.labValues.find((row) => row.core && row.metricName === 'hba1c');
    expect(hba1c).toMatchObject({ value: 40 });
    expect(hba1c).not.toHaveProperty('comparator');
    expect(file.labValues.find((row) => row.metricName === 'eGFR')).toMatchObject({ value: 90, comparator: '>' });
    expect(file.labValues.find((row) => row.metricName === 'CRP')).not.toHaveProperty('comparator');
  });

  it('My data shows the latest LDL as "< 2.0", and its trend draws only the exact values', () => {
    const ldl = myData(withReport(), NOW).bloodTests.find((row) => row.metric === 'ldl')!;
    expect(ldl.latest).toMatchObject({ value: '< 2.0', day: '2026-10-01' });
    expect(ldl.trend).toEqual([3.1, 2.9]);
    // In US units the bound keeps the places that hold it exactly (health-core limitText).
    const us = edited(withReport(), { kind: 'units', unitSystem: 'conventional' });
    expect(myData(us, NOW).bloodTests.find((row) => row.metric === 'ldl')!.latest?.value).toBe('< 77.34');
  });

  it('the history row says the limit, carries its bound for the chart, and the plan\'s word when it cannot grade it', () => {
    const history = metricHistory(withReport(), 'ldl', NOW);
    const [limit, ...exact] = history.rows;
    expect(limit).toMatchObject({ value: '< 2.0', bound: 2, current: true, note: LIMIT_NOT_GRADED });
    expect(exact.map((row) => row.value)).toEqual(['2.9', '3.1']);
    for (const row of exact) {
      expect(row).not.toHaveProperty('bound');
      expect(row).not.toHaveProperty('note');
    }
    // What Swift decodes: the same row through the door.
    const door = JSON.parse(historyJson(JSON.stringify(withReport()), 'ldl', NOW, 'phone', '{}'));
    expect(door.rows[0]).toMatchObject({ value: '< 2.0', bound: 2, note: LIMIT_NOT_GRADED });
  });

  it('a limit the bound decides is used in the plan, so it carries no note', () => {
    const decided = { ...extraction, values: [{ ...extraction.values[0], valueSI: 1, displayValue: 1 }] };
    const file = edited(newRecord(NOW, 'phone', 'en-NZ', 'Pacific/Auckland'),
      { kind: 'profile', sex: 'male', birthYear: 1966, birthMonth: 1, height: 180 },
      { kind: 'labImport', extractionJson: JSON.stringify(decided), refs: ['v0'], reportDay: '2026-10-01' });
    const [row] = metricHistory(file, 'ldl', NOW).rows;
    expect(row).toMatchObject({ value: '< 1.0', bound: 1, current: true });
    expect(row).not.toHaveProperty('note');
  });

  it('the bound is in the unit the page shows', () => {
    const us = edited(withReport(), { kind: 'units', unitSystem: 'conventional' });
    const [limit] = metricHistory(us, 'ldl', NOW).rows;
    expect(limit.value).toBe('< 77.34');
    expect(limit.bound).toBeCloseTo(77.34, 6);
  });

  it('the plan tab\'s screen carries the same strings', () => {
    const screen = JSON.parse(screenJson(JSON.stringify(withReport()), NOW, 'phone', '{}'));
    expect(screen.myData.bloodTests.find((row: { metric: string }) => row.metric === 'ldl').latest.value).toBe('< 2.0');
  });
});
