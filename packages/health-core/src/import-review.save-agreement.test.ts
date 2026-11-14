// US-13 AC13 (ruling D): the review's groups agree with what Save does. For
// each fixture every sent value is written, in the review's order, by the real
// write path; what it did must be what the review said.
import { describe, it, expect } from 'vitest';
import { classifyImportValues, type ClassifiedValue, type ImportFile } from './import-review';
import { bulkAppendValues, type BulkRow } from './record-edits';
import { UNDATED_PREVIOUS } from './lab-extraction';
import type { RoadmapFile } from './roadmap-file';
import { core, DAY, EMPTY, extra, lab, NOW, recordWith } from './import-review.test-helpers';

/** The row Save sends for one value: the iPhone's `labRows` shape. */
function rowOf(file: ImportFile, ref: string): BulkRow {
  const day = file.days[ref]!;
  const limit = (c?: string) => (c ? { comparator: c } : null);
  if (ref[0] === 'v') {
    const v = file.result.values![Number(ref.slice(1))];
    return { kind: 'measurement', metricType: v.metric, value: v.valueSI, recordedAt: day, source: 'lab_import', ...limit(v.comparator) } as BulkRow;
  }
  const a = file.result.additionalValues![Number(ref.slice(1))];
  return { kind: 'lab', metricName: a.name, value: a.value, unit: a.unit, referenceLow: a.referenceLow ?? null, referenceHigh: a.referenceHigh ?? null, recordedAt: day, source: 'lab_import', ...limit(a.comparator) } as BulkRow;
}

/** What Save did with each sent value, sent in the review's order: refused (the
 *  whole batch's own refusals, or a lab's, which is the row's own), else
 *  written or skipped, read from the write itself: the row wrote when the
 *  batch up to it saved one more row than the batch before it. */
function whatSaveDid(files: ImportFile[], record: RoadmapFile, values: ClassifiedValue[]) {
  const sent = values.filter((v) => v.sent && (v.ref[0] === 'v' || v.ref[0] === 'a'));
  const rows = sent.map((v) => rowOf(files[v.file], v.ref));
  const refusedIndex = new Set(bulkAppendValues(record, rows, NOW).measurementRefusals.map((r) => r.index));
  const savedUpTo = (n: number) => bulkAppendValues(record, rows.slice(0, n), NOW).saved.length;
  return sent.map((v, i) => {
    const row = rows[i];
    if (refusedIndex.has(i) || (row.kind === 'lab' && bulkAppendValues(EMPTY, [row], NOW).refused.length > 0)) return { v, did: 'refused' as const };
    return { v, did: savedUpTo(i + 1) > savedUpTo(i) ? 'written' as const : 'skipped' as const };
  });
}

const HELD = recordWith([
  { kind: 'measurement', metricType: 'ldl', value: 2.4 },
  { kind: 'measurement', metricType: 'hdl', value: 1.2 },
  { kind: 'lab', metricName: 'ferritin', value: 60, unit: 'µg/L' },
  { kind: 'measurement', metricType: 'systolic_bp', value: 120, recordedAt: '2026-10-01' },
]);

const FIXTURES: Array<[string, ImportFile[], RoadmapFile]> = [
  ['plain values', [lab({ values: [core(), core({ metric: 'hdl', valueSI: 1.3 })], additionalValues: [extra(), extra({ name: 'TSH', value: 2, unit: 'mIU/L' })] })], EMPTY],
  ['against held rows: equal, different, free', [lab({ values: [core({ valueSI: 2.4 }), core({ metric: 'hdl', valueSI: 1.5 }), core({ metric: 'hba1c', valueSI: 40, displayUnit: 'mmol/mol' })], additionalValues: [extra({ value: 60 }), extra({ name: 'TSH', value: 2, unit: 'mIU/L' })] })], HELD],
  ['refusals: unit, no unit, plausible, scale, core range', [lab({ values: [core({ valueSI: 500 })], additionalValues: [extra({ unit: 'furlongs' }), extra({ unit: '' }), extra({ name: 'Sodium', value: 1000, unit: 'mmol/L' }), extra({ name: 'WBC', value: 6.5, unit: 'cells/µL' }), extra({ name: 'HbA1c', value: 40, unit: 'furlongs' })] })], EMPTY],
  ['inverted blood pressure, systolic 80 and diastolic 120', [lab({ values: [core({ metric: 'systolic_bp', valueSI: 80, displayUnit: 'mmHg' }), core({ metric: 'diastolic_bp', valueSI: 120, displayUnit: 'mmHg' })] })], EMPTY],
  ['a diastolic above the systolic already held', [lab({ values: [core({ metric: 'diastolic_bp', valueSI: 130, displayUnit: 'mmHg' })] }, { day: '2026-10-01' })], HELD],
  ['primary against a previous column, previous file first', [lab({ values: [core({ valueSI: 2.9, recordedAt: DAY })] }, { day: '2026-12-01' }), lab({ values: [core()] })], EMPTY],
  ['a winner equal to the record and a differing reading', [lab({ values: [core({ valueSI: 2.4 }), core({ valueSI: 3.0 })] })], HELD],
  ['an undated column dated onto a held day', [lab({ values: [core({ recordedAt: UNDATED_PREVIOUS })] }, { undatedDay: DAY })], HELD],
  ['a question row unticked frees the slot (F4)', [lab({ values: [core({ question: 'Was this a blood test?' }), core({ valueSI: 2.9 })] }, { unsent: ['v0'] })], EMPTY],
  ['two equal readings', [lab({ values: [core(), core()] })], EMPTY],
  ['limits against exact values', [lab({ values: [core({ metric: 'psa', valueSI: 0.1, comparator: '<' })], additionalValues: [extra({ comparator: '>' })] })], recordWith([{ kind: 'measurement', metricType: 'psa', value: 0.1 }, { kind: 'lab', metricName: 'ferritin', value: 80, unit: 'µg/L' }])],
];

describe('the review agrees with Save (ruling D)', () => {
  it.each(FIXTURES)('%s', (_name, files, record) => {
    const values = classifyImportValues(files, record, NOW);
    const did = whatSaveDid(files, record, values);
    for (const { v, did: outcome } of did) {
      const expected = v.group === 'sure' ? ['written']
        : v.group === 'saved' ? ['skipped']
          : v.group === 'notSaved' ? ['refused', 'skipped']
            : v.group === 'unsure' && v.reasons.includes('conflict') ? ['skipped', 'refused']
              : v.group === 'unsure' && v.reasons.includes('outOfRange') ? ['refused']
                : ['written'];
      expect({ ref: `${v.file}:${v.ref}`, group: v.group, did: outcome }).toEqual({ ref: `${v.file}:${v.ref}`, group: v.group, did: expect.toBeOneOf(expected) });
    }
    // Nothing classed sure is ever refused, and every refused value was flagged before Save.
    expect(did.filter((d) => d.did === 'refused' && d.v.group === 'sure')).toEqual([]);
  });

  it('an inverted blood pressure is never sure', () => {
    const values = classifyImportValues(FIXTURES[3][1], EMPTY, NOW);
    expect(values.map((v) => (v.group === 'unsure' ? v.reasons : v.group))).toEqual([['outOfRange'], ['outOfRange']]);
  });
});
