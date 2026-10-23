// US-52 AC8 characterisation pins (plan docs/reviews/2026-10-23-mcp-dedup-plan.md,
// step 1): the rows `labRows` builds and its refusal words, as the app reads
// them through `labImport` (my-data.ts) and `labSaveSummaryJson` (app-doors.ts).
// A later de-dup must leave every pin byte-identical. Synthetic values.
import { describe, expect, it } from 'vitest';
import { labSaveSummaryJson } from './app-doors';
import { applyEdit, newRecord } from './my-data';
import { labRows } from './lab-review';
import type { RoadmapFile } from '../../packages/health-core/src/roadmap-file';

const NOW = '2026-10-21T08:00:00.000Z';
const DEVICE = 'ios-pins';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

function record(...edits: Parameters<typeof applyEdit>[1][]): RoadmapFile {
  return edits.reduce((file, edit) => {
    const out = applyEdit(file, edit, NOW);
    if (!out.ok) throw new Error(out.message);
    return out.file;
  }, newRecord(NOW, DEVICE, 'en-NZ', 'Pacific/Auckland'));
}

const extraction = {
  classification: 'lab_report', reportDate: '2026-10-01',
  values: [
    { metric: 'ldl', valueSI: 3.1, displayValue: 3.1, displayUnit: 'mmol/L', displaySystem: 'si', confidence: 'high' },
    { metric: 'hba1c', valueSI: 40, displayValue: 40, displayUnit: 'mmol/mol', displaySystem: 'si', confidence: 'medium', recordedAt: '2025-04-02' },
    { metric: 'hdl', valueSI: 1.3, displayValue: 1.3, displayUnit: 'mmol/L', displaySystem: 'si', confidence: 'high', recordedAt: '2027-01-01' },
  ],
  additionalValues: [
    { name: 'Ferritin', value: 85, unit: 'µg/L', referenceLow: 30, referenceHigh: 300 },
    { name: 'Ferritin', value: 85, unit: 'furlongs' },
    { name: 'Sodium', value: 140, unit: 'mmol/L', recordedAt: '2025-04-02' },
  ],
};
const json = JSON.stringify(extraction);

/** What `labImport` appended, ids masked. */
function appended(before: RoadmapFile, after: RoadmapFile): string {
  const fresh = <T extends { id: string }>(old: T[], next: T[]) => next.filter((r) => !old.some((o) => o.id === r.id));
  let n = 0;
  const ids = new Map<string, string>();
  return JSON.stringify({ measurements: fresh(before.measurements, after.measurements), labValues: fresh(before.labValues, after.labValues) })
    .replace(UUID, (u) => (ids.has(u) ? ids.get(u)! : (ids.set(u, `<uuid-${++n}>`), ids.get(u)!)));
}

describe('US-52 AC8 pins — labRows, labImport and labSaveSummaryJson answer as today', () => {
  it('labRows: each ticked value on its own day or the report day', () => {
    expect(JSON.stringify(labRows(extraction as never, ['v0', 'v1', 'a0', 'a2'], '2026-10-01', NOW))).toMatchSnapshot();
  });

  it('labRows refusals, word for word', () => {
    expect([
      labRows(extraction as never, ['v9'], '2026-10-01', NOW),
      labRows(extraction as never, ['x0'], '2026-10-01', NOW),
      labRows(extraction as never, ['v0'], '2027-01-01', NOW),
      labRows(extraction as never, ['v0'], '', NOW),
      labRows(extraction as never, ['v2'], '2026-10-01', NOW),
    ].map((r) => JSON.stringify(r))).toMatchSnapshot();
  });

  it('labImport appends the rows, skipping a held day and leaving a refused unit out', () => {
    const before = record({ kind: 'add', metric: 'ldl', value: 2.5, day: '2026-10-01' });
    const out = applyEdit(before, { kind: 'labImport', extractionJson: json, refs: ['v0', 'v1', 'a0', 'a1', 'a2'], reportDay: '2026-10-01' }, NOW);
    if (!out.ok) throw new Error(out.message);
    expect(appended(before, out.file)).toMatchSnapshot();
    expect(['v9', 'v2'].map((ref) => JSON.stringify(applyEdit(before, { kind: 'labImport', extractionJson: json, refs: [ref], reportDay: '2026-10-01' }, NOW)))).toMatchSnapshot();
  });

  it('labSaveSummaryJson: the summary, and each refusal, byte for byte', () => {
    const file = JSON.stringify(record({ kind: 'add', metric: 'ldl', value: 2.5, day: '2026-10-01' }));
    const door = (refs: string[], day: string) => labSaveSummaryJson(file, json, JSON.stringify(refs), day, NOW, DEVICE);
    expect([
      door(['v0', 'v1', 'a0', 'a1', 'a2'], '2026-10-01'),
      door(['v9'], '2026-10-01'),
      door(['v0'], '2027-01-01'),
      door(['v0'], ''),
      door(['v2'], '2026-10-01'),
      door(['v1'], ''),
    ]).toMatchSnapshot();
  });
});
