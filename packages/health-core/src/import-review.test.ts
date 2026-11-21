// US-13 AC13: the import review's groups, summary and "Not saved" words,
// one rule for the website and the iPhone (docs/drafts/import-review-redesign.md).
import { describe, it, expect } from 'vitest';
import {
  classifyImportValues, importRow, importSummary, importSummaryText, IMPORT_REVIEW_TEXT, notSavedGroups, recordFromHistory, valueDays,
  type ClassifiedValue, type ImportFile,
} from './import-review';
import { UNDATED_PREVIOUS } from './lab-extraction';
import type { RoadmapFile } from './roadmap-file';
import { core, DAY, EMPTY, extra, lab, NOW, recordWith } from './import-review.test-helpers';

const classify = (files: ImportFile[], record: RoadmapFile = EMPTY) => classifyImportValues(files, record, NOW).values;
const one = (file: ImportFile, record: RoadmapFile = EMPTY): ClassifiedValue => {
  const all = classify([file], record);
  expect(all).toHaveLength(1);
  return all[0];
};
const shape = (v: ClassifiedValue) => (v.group === 'unsure' ? { group: v.group, reasons: v.reasons } : v.group === 'notSaved' ? { group: v.group, reason: v.reason } : { group: v.group });

const LDL_HELD = recordWith([{ kind: 'measurement', metricType: 'ldl', value: 2.4 }]);
const LDL_SAME = recordWith([{ kind: 'measurement', metricType: 'ldl', value: 3.1 }]);
const FERRITIN_HELD = recordWith([{ kind: 'lab', metricName: 'ferritin', value: 60, unit: 'µg/L' }]);
const FERRITIN_SAME = recordWith([{ kind: 'lab', metricName: 'ferritin', value: 80, unit: 'µg/L' }]);

describe('classifyImportValues: one row per signal (US-13 AC13, D1)', () => {
  it.each<[string, ImportFile, RoadmapFile, object]>([
    ['a confident core value is sure', lab({ values: [core()] }), EMPTY, { group: 'sure' }],
    ['medium confidence asks for a look', lab({ values: [core({ confidence: 'medium' })] }), EMPTY, { group: 'unsure', reasons: ['confidence'] }],
    ['a question asks for a look', lab({ values: [core({ question: 'Was this a blood test?' })] }), EMPTY, { group: 'unsure', reasons: ['question'] }],
    ['a guessed unit asks for a look', lab({ values: [core({ unitGuessed: true })] }), EMPTY, { group: 'unsure', reasons: ['unitGuessed'] }],
    ['a core value the write refuses for its range is never hidden', lab({ values: [core({ valueSI: 500 })] }), EMPTY, { group: 'unsure', reasons: ['outOfRange'] }],
    ['a different value held that day is a conflict', lab({ values: [core()] }), LDL_HELD, { group: 'unsure', reasons: ['conflict'] }],
    ['the same value held that day is already saved', lab({ values: [core()] }), LDL_SAME, { group: 'saved' }],
    ['a value with no day yet waits behind the date question', lab({ values: [core()] }, { day: null }), LDL_HELD, { group: 'waiting' }],
    ['an undated column waits until its day is picked', lab({ values: [core({ recordedAt: UNDATED_PREVIOUS })] }), EMPTY, { group: 'waiting' }],
    ['a day that is not a real day waits', lab({ values: [core()] }, { day: '2026-02-30' }), EMPTY, { group: 'waiting' }],
    ['a catalogued lab in its unit is sure', lab({ additionalValues: [extra()] }), EMPTY, { group: 'sure' }],
    ['a known conversion is sure', lab({ additionalValues: [extra({ unit: 'ng/mL' })] }), EMPTY, { group: 'sure' }],
    ['a test not in the catalogue is sure (Q3 a)', lab({ additionalValues: [extra({ name: 'Mystery marker', unit: 'zz' })] }), EMPTY, { group: 'sure' }],
    ['a lab the model doubted asks for a look', lab({ additionalValues: [extra({ confidence: 'low' })] }), EMPTY, { group: 'unsure', reasons: ['confidence'] }],
    ['a different lab held that day is a conflict', lab({ additionalValues: [extra()] }), FERRITIN_HELD, { group: 'unsure', reasons: ['conflict'] }],
    ['the same lab held, in another spelling, is already saved', lab({ additionalValues: [extra({ unit: 'ng/mL' })] }), FERRITIN_SAME, { group: 'saved' }],
    ['a unit the test does not take', lab({ additionalValues: [extra({ unit: 'furlongs' })] }), EMPTY, { group: 'notSaved', reason: 'unit' }],
    ['no unit printed', lab({ additionalValues: [extra({ unit: '' })] }), EMPTY, { group: 'notSaved', reason: 'noUnit' }],
    ['a unit refusal is known before a day is set', lab({ additionalValues: [extra({ unit: 'furlongs' })] }, { day: null }), EMPTY, { group: 'notSaved', reason: 'unit' }],
    ['past the plausible range', lab({ additionalValues: [extra({ name: 'Sodium', value: 1000, unit: 'mmol/L' })] }), EMPTY, { group: 'notSaved', reason: 'misread' }],
    ['past the ceiling a prefix step reaches', lab({ additionalValues: [extra({ name: 'Reticulocytes', value: 5, unit: '×10¹²/L' })] }), EMPTY, { group: 'notSaved', reason: 'misread' }],
    ['a count per µL that is not whole', lab({ additionalValues: [extra({ name: 'WBC', value: 6.5, unit: 'cells/µL' })] }), EMPTY, { group: 'notSaved', reason: 'scale' }],
    ['a core test filed as a lab converts as core', lab({ additionalValues: [extra({ name: 'HbA1c', value: 40, unit: 'mmol/mol' })] }), EMPTY, { group: 'sure' }],
    ['a core test filed as a lab, already held as core', lab({ additionalValues: [extra({ name: 'HbA1c', value: 40, unit: 'mmol/mol' })] }), recordWith([{ kind: 'measurement', metricType: 'hba1c', value: 40 }]), { group: 'saved' }],
    ['a core test filed as a lab in a unit it does not take', lab({ additionalValues: [extra({ name: 'HbA1c', value: 40, unit: 'furlongs' })] }), EMPTY, { group: 'notSaved', reason: 'unit' }],
    ['a creatinine with no unit', lab({ refusedValues: [{ metric: 'creatinine', value: 80, unit: '', reason: 'No unit was printed.' }] }), EMPTY, { group: 'notSaved', reason: 'noUnit' }],
    ['a creatinine in a urine unit', lab({ refusedValues: [{ metric: 'creatinine', value: 3, unit: 'mg/mmol', reason: 'x' }] }), EMPTY, { group: 'notSaved', reason: 'urine' }],
    ['a creatinine in an unknown unit', lab({ refusedValues: [{ metric: 'creatinine', value: 3, unit: 'zz', reason: 'x' }] }), EMPTY, { group: 'notSaved', reason: 'unit' }],
    ['an unreadable number', lab({ unreadValues: [{ name: 'tsh', reason: 'unreadable' }], droppedValueCount: 1 }), EMPTY, { group: 'notSaved', reason: 'unreadable' }],
  ])('%s', (_name, file, record, expected) => {
    expect(shape(one(file, record))).toEqual(expected);
  });

  it('collects every reason a value has, and names the test by its label, never a key', () => {
    const [v] = classify([lab({ values: [core({ metric: 'lpa', valueSI: 50, confidence: 'low', question: 'Check the unit.', unitGuessed: true })] })]);
    expect(v).toMatchObject({ group: 'unsure', reasons: ['confidence', 'question', 'unitGuessed'], label: 'Lp(a)', ref: 'v0', file: 0, sent: true });
    const [u] = classify([lab({ unreadValues: [{ name: 'immature_granulocytes', reason: 'unreadable' }], droppedValueCount: 1 })]);
    expect(u.label).toBe('Immature granulocytes');
  });

  it('counts dropped rows that name no test, and skips documents', () => {
    const files: ImportFile[] = [
      { result: { classification: 'clinic_letter', document: { classification: 'clinic_letter', title: 'Letter', documentDate: null, contentMarkdown: 'x', metadata: {} } }, rows: {}, days: {} },
      lab({ unreadValues: [{ name: 'tsh', reason: 'unreadable' }, { name: '', reason: 'unreadable' }], droppedValueCount: 3 }),
    ];
    expect(classify(files).map((v) => [v.file, v.ref, v.label])).toEqual([[1, 'u0', 'TSH'], [1, 'u1', ''], [1, 'u2', '']]);
  });
});

describe('effective days (ruling B)', () => {
  it('an undated column the person dates onto a day the record holds differently is a conflict, never sure', () => {
    const file = lab({ values: [core({ recordedAt: UNDATED_PREVIOUS })] }, { undatedDay: DAY });
    expect(shape(one(file, LDL_HELD))).toEqual({ group: 'unsure', reasons: ['conflict'] });
    expect(shape(one(lab({ values: [core({ recordedAt: UNDATED_PREVIOUS })] }), LDL_HELD))).toEqual({ group: 'waiting' });
  });

  it('valueDays: own day, the file day, the picked undated day', () => {
    const result = { classification: 'lab_report', values: [core(), core({ recordedAt: '2026-01-01' }), core({ recordedAt: UNDATED_PREVIOUS })] };
    expect(valueDays(result, DAY)).toEqual({ v0: DAY, v1: '2026-01-01', v2: null });
    expect(valueDays(result, null, '2025-06-01')).toEqual({ v0: null, v1: '2026-01-01', v2: '2025-06-01' });
  });
});

describe('slot precedence (ruling A, US-12 AC12, AC14)', () => {
  const primary = core({ valueSI: 3.1 });
  const previous = core({ valueSI: 2.9, recordedAt: DAY });
  const reportOf = (day: string, v: ReturnType<typeof core>) => lab({ values: [v] }, { day });
  it.each([['primary file first', false], ['previous-column file first', true]])('a report\'s own reading wins over a dated previous column (%s)', (_name, reversed) => {
    const files = [reportOf(DAY, primary), reportOf('2026-12-01', previous)];
    const out = classify(reversed ? [files[1], files[0]] : files);
    const byValue = (fileIndex: number) => out.find((v) => v.file === fileIndex)!;
    const [p, q] = reversed ? [byValue(1), byValue(0)] : [byValue(0), byValue(1)];
    expect(shape(p)).toEqual({ group: 'sure' });
    expect(shape(q)).toEqual({ group: 'notSaved', reason: 'sameDay' });
  });

  it('a winner equal to the record does not block a differing reading of its rank: that one is the conflict', () => {
    const out = classify([lab({ values: [core({ valueSI: 2.4 }), core({ valueSI: 3.1 })] })], LDL_HELD);
    expect(out.map(shape)).toEqual([{ group: 'saved' }, { group: 'unsure', reasons: ['conflict'] }]);
  });

  it('a primary equal to the record still blocks a differing previous column', () => {
    const out = classify([reportOf(DAY, core({ valueSI: 2.4 })), reportOf('2026-12-01', core({ valueSI: 3.0, recordedAt: DAY }))], LDL_HELD);
    expect(out.map(shape)).toEqual([{ group: 'saved' }, { group: 'notSaved', reason: 'sameDay' }]);
  });

  it('an equal second reading is saved with the first, not "not saved"', () => {
    expect(classify([lab({ values: [core(), core()] })]).map(shape)).toEqual([{ group: 'sure' }, { group: 'saved' }]);
  });

  it('unticking the first reading frees the slot for the second (F4)', () => {
    const values = [core({ question: 'Was this a blood test?' }), core({ valueSI: 2.9 })];
    expect(classify([lab({ values })]).map(shape)).toEqual([{ group: 'unsure', reasons: ['question'] }, { group: 'notSaved', reason: 'sameDay' }]);
    const out = classify([lab({ values }, { unsent: ['v0'] })]);
    expect(out.map((v) => [v.ref, v.sent, shape(v)])).toEqual([['v1', true, { group: 'sure' }], ['v0', false, { group: 'unsure', reasons: ['question'] }]]);
  });

  it('lists sent values in the order Save must send them: by rank, then file order', () => {
    const out = classify([lab({ values: [core({ recordedAt: '2026-10-01' }), core({ metric: 'hdl', valueSI: 1.2 })] })]);
    expect(out.map((v) => v.ref)).toEqual(['v1', 'v0']);
  });
});

describe('the website\'s history as a record', () => {
  it('classifies alike from the history and from the record it came from, limits included', () => {
    const history = {
      measurements: [{ id: 'm1', metricType: 'ldl', value: 2.4, recordedAt: DAY, createdAt: NOW }, { id: 'm2', metricType: 'psa', value: 0.1, recordedAt: DAY, createdAt: NOW, comparator: '<' as const }],
      labValues: [{ id: 'l1', metricName: 'ferritin', value: 80, unit: 'µg/L', recordedAt: DAY, createdAt: NOW, comparator: '>' as const }],
    };
    const fromHistory = recordFromHistory(history.measurements, history.labValues);
    const fromWrite = recordWith([
      { kind: 'measurement', metricType: 'ldl', value: 2.4 },
      { kind: 'measurement', metricType: 'psa', value: 0.1, comparator: '<' },
      { kind: 'lab', metricName: 'ferritin', value: 80, unit: 'µg/L', comparator: '>' },
    ]);
    const files = [lab({ values: [core(), core({ metric: 'psa', valueSI: 0.1, comparator: '<' })], additionalValues: [extra({ comparator: '>' }), extra({ name: 'TSH', unit: 'mIU/L', value: 2 })] })];
    expect(classify(files, fromHistory)).toEqual(classify(files, fromWrite));
    expect(classify(files, fromHistory).map(shape)).toEqual([{ group: 'unsure', reasons: ['conflict'] }, { group: 'saved' }, { group: 'saved' }, { group: 'sure' }]);
  });
});

describe('the review per D3 case', () => {
  const groups = (files: ImportFile[], record: RoadmapFile = EMPTY) => {
    const all = classify(files, record);
    const count = (g: ClassifiedValue['group']) => all.filter((v) => v.group === g).length;
    return { sure: count('sure'), unsure: count('unsure'), notSaved: count('notSaved'), saved: count('saved'), summary: importSummaryText(importSummary(files)) };
  };
  it('zero unsure: a summary and Save, no rows', () => {
    expect(groups([lab({ values: [core()], additionalValues: [extra()] })])).toEqual({ sure: 2, unsure: 0, notSaved: 0, saved: 0, summary: 'Found 2 blood test values' });
  });
  it('only unsure: the rows and Save, nothing behind Show all', () => {
    expect(groups([lab({ values: [core({ unitGuessed: true })] })])).toEqual({ sure: 0, unsure: 1, notSaved: 0, saved: 0, summary: 'Found 1 blood test value' });
  });
  it('nothing to save: the summary and the Not saved line', () => {
    const files = [lab({ refusedValues: [{ metric: 'creatinine', value: 3, unit: 'mg/mmol', reason: 'x' }], unreadValues: [{ name: 'tsh', reason: 'unreadable' }], droppedValueCount: 1 })];
    expect(groups(files)).toEqual({ sure: 0, unsure: 0, notSaved: 2, saved: 0, summary: 'No blood test values or documents found.' });
  });
  it('already saved: counted, not a row and not Not saved', () => {
    expect(groups([lab({ values: [core()] })], LDL_SAME)).toMatchObject({ sure: 0, unsure: 0, notSaved: 0, saved: 1 });
  });
});

describe('importSummaryText (strings 1 to 3)', () => {
  const doc = (classification: string): ImportFile => ({ result: { classification, document: { classification, title: 't', documentDate: null, contentMarkdown: '', metadata: {} } }, rows: {}, days: {} });
  it('counts values and documents by kind across files', () => {
    const files = [lab({ values: [core()], additionalValues: [extra(), extra({ name: 'TSH', unit: 'mIU/L', value: 2 })] }), doc('clinic_letter'), doc('scan_result'), doc('scan_result')];
    expect(importSummaryText(importSummary(files))).toBe('Found 3 blood test values, 2 scan results and 1 clinic letter in 4 files');
  });
  it('a single document, and an unknown kind as other', () => {
    expect(importSummaryText(importSummary([doc('discharge_summary')]))).toBe('Found 1 discharge summary');
    expect(importSummaryText(importSummary([doc('mystery'), doc('other')]))).toBe('Found 2 other documents in 2 files');
  });
});

describe('notSavedGroups (D5, strings 13 and 17 to 24)', () => {
  it('names each test once per reason, in the person\'s words, and counts the unnamed rest', () => {
    const files = [lab({
      additionalValues: [extra({ unit: 'furlongs' }), extra({ name: 'TSH', unit: 'zz' }), extra({ unit: '' })],
      unreadValues: [{ name: 'tsh', reason: 'unreadable' }], droppedValueCount: 3,
    }), lab({ additionalValues: [extra({ unit: 'furlongs', recordedAt: '2026-10-01' })] })];
    const groups = notSavedGroups(classify(files));
    expect(groups.total).toBe(7);
    expect(groups.lines.map((l) => l.text)).toEqual([
      'Ferritin, TSH: this unit is not one we know for this test',
      'Ferritin: no unit was printed',
      'TSH: could not be read',
    ]);
    expect(groups.other).toBe('2 other values could not be read');
    expect(IMPORT_REVIEW_TEXT.notSavedTitle(groups.total)).toBe('7 values not saved');
  });
  it('says "other" only beside named lines, and never shows agent text or a key', () => {
    expect(notSavedGroups(classify([lab({ droppedValueCount: 1 })]))).toEqual({ total: 1, lines: [], other: '1 value could not be read' });
    const words = JSON.stringify(notSavedGroups(classify([lab({ additionalValues: [extra({ name: 'immature_granulocytes', unit: 'zz' })] })])));
    expect(words).not.toMatch(/immature_granulocytes|Do not|Ask the person/);
  });
});

describe('IMPORT_REVIEW_TEXT (strings 4 to 14)', () => {
  it('counts in words', () => {
    expect(IMPORT_REVIEW_TEXT.checkTitle(3)).toBe('Check these 3 values');
    expect(IMPORT_REVIEW_TEXT.checkTitle(1)).toBe('Check this value');
    expect(IMPORT_REVIEW_TEXT.save(1)).toBe('Save 1 value');
    expect(IMPORT_REVIEW_TEXT.notSavedTitle(1)).toBe('1 value not saved');
    expect(IMPORT_REVIEW_TEXT.willSave(1)).toBe('1 value will be saved');
    expect(IMPORT_REVIEW_TEXT.showAll(12)).toBe('Show all 12');
    expect(IMPORT_REVIEW_TEXT.alreadySaved(2)).toBe('2 already in your record');
    expect(IMPORT_REVIEW_TEXT.save(12)).toBe('Save 12 values');
  });
});

describe('PR 1826 fix round (US-13 AC13)', () => {
  it("a blood pressure the wrong way up is unsure, never written, and carries the write's own refusal for the cell", () => {
    const values = classify([lab({ values: [core({ metric: 'systolic_bp', valueSI: 80, displayUnit: 'mmHg' }), core({ metric: 'diastolic_bp', valueSI: 120, displayUnit: 'mmHg' })] })]);
    expect(values).toHaveLength(2);
    expect(values.every((v) => v.group === 'unsure' && !v.writes && v.reasons.includes('outOfRange') && !!v.refusal)).toBe(true);
  });

  it("an equal reading of this upload is saved as a duplicate (one copy saves); the record's own equal value is not", () => {
    const twice = classify([lab({ values: [core()] }), lab({ values: [core()] })]);
    expect(twice.map((v) => [v.group, v.writes, 'duplicate' in v && v.duplicate === true])).toEqual([['sure', true, false], ['saved', false, true]]);
    const held = one(lab({ values: [core()] }), LDL_SAME);
    expect([held.group, 'duplicate' in held ? held.duplicate : undefined]).toEqual(['saved', undefined]);
  });

  it('a reading the write refuses alone takes no slot: the valid reading of that day is written (refusedAlone)', () => {
    const values = classify([lab({ additionalValues: [extra({ value: 10, unit: 'furlongs' })] }), lab({ additionalValues: [extra({ value: 85, confidence: 'low' })] })]);
    expect(values.map((v) => [v.file, v.group, v.writes]).sort()).toEqual([[0, 'notSaved', false], [1, 'unsure', true]]);
  });

  it('importSummary counts a document by its kind even when its file also holds values', () => {
    const letter = { classification: 'lab_report', values: [core()], document: { classification: 'clinic_letter', title: 'x', documentDate: null, contentMarkdown: '', metadata: {} } } as ImportFile['result'];
    expect(importSummaryText(importSummary([{ result: letter }]))).toBe('Found 1 blood test value and 1 clinic letter');
  });
});

describe('US-12 AC20: an edited limit saves exact', () => {
  const result = { values: [core({ metric: 'lpa', valueSI: 10, displayValue: 10, displayUnit: 'nmol/L', comparator: '<' })], additionalValues: [extra({ value: 5, comparator: '<' })] } as ImportFile['result'];

  it('a core "< 10" Lp(a) edited to 12 saves 12 with no limit sign; unedited it keeps "<"', () => {
    expect(importRow(result, 'v0', DAY, { edited: { value: 12 } })).toEqual({ kind: 'measurement', metricType: 'lpa', value: 12, recordedAt: DAY, source: 'lab_import_edited' });
    expect(importRow(result, 'v0', DAY)).toMatchObject({ value: 10, comparator: '<', source: 'lab_import' });
  });

  it('a lab "< 5" edited to 7 saves 7 with no limit sign; unedited it keeps "<"', () => {
    const edited = importRow(result, 'a0', DAY, { edited: { value: 7 } });
    expect(edited).toMatchObject({ kind: 'lab', value: 7, source: 'lab_import_edited' });
    expect(edited).not.toHaveProperty('comparator');
    expect(importRow(result, 'a0', DAY)).toMatchObject({ value: 5, comparator: '<', source: 'lab_import' });
  });
});
