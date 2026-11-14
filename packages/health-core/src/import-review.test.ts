// US-13 AC13: the import review's groups, summary and "Not saved" words,
// one rule for the website and the iPhone (docs/drafts/import-review-redesign.md).
import { describe, it, expect } from 'vitest';
import {
  classifyImportValues, heldSlots, heldSlotsFromFile, importSummary, importSummaryText, IMPORT_REVIEW_TEXT, notSavedGroups,
  type ClassifiedValue, type HeldValue, type ImportFile,
} from './import-review';
import { UNDATED_PREVIOUS, type AdditionalLabValue, type ExtractedValue } from './lab-extraction';
import { bulkAppendValues, slotKey } from './record-edits';
import { createEmptyFile } from './roadmap-file';

const DAY = '2026-11-01';
const NONE: ReadonlyMap<string, HeldValue> = new Map();

const core = (over: Partial<ExtractedValue> = {}): ExtractedValue => ({
  metric: 'ldl', valueSI: 3.1, displayValue: 3.1, displayUnit: 'mmol/L', displaySystem: 'si', confidence: 'high', ...over,
});
const extra = (over: Partial<AdditionalLabValue> = {}): AdditionalLabValue => ({ name: 'Ferritin', value: 80, unit: 'µg/L', ...over });
const lab = (result: Partial<ImportFile['result']>, day: string | null = DAY): ImportFile => ({ result: { classification: 'lab_report', ...result }, day });
const one = (file: ImportFile, held = NONE): ClassifiedValue => {
  const all = classifyImportValues([file], held);
  expect(all).toHaveLength(1);
  return all[0];
};
const shape = (v: ClassifiedValue) => (v.group === 'unsure' ? { group: v.group, reasons: v.reasons } : v.group === 'notSaved' ? { group: v.group, reason: v.reason } : { group: v.group });

describe('classifyImportValues: one row per signal (US-13 AC13, D1)', () => {
  const ldlSlot = slotKey('measurement', 'ldl', DAY);
  const ferritinSlot = slotKey('lab', 'Ferritin', DAY);
  it.each<[string, ImportFile, ReadonlyMap<string, HeldValue>, object]>([
    ['a confident core value is sure', lab({ values: [core()] }), NONE, { group: 'sure' }],
    ['medium confidence asks for a look', lab({ values: [core({ confidence: 'medium' })] }), NONE, { group: 'unsure', reasons: ['confidence'] }],
    ['a question asks for a look', lab({ values: [core({ question: 'Was this a blood test?' })] }), NONE, { group: 'unsure', reasons: ['question'] }],
    ['a guessed unit asks for a look', lab({ values: [core({ unitGuessed: true })] }), NONE, { group: 'unsure', reasons: ['unitGuessed'] }],
    ['a core value outside its input range is never hidden', lab({ values: [core({ valueSI: 500 })] }), NONE, { group: 'unsure', reasons: ['outOfRange'] }],
    ['a different value held that day is a conflict', lab({ values: [core()] }), new Map([[ldlSlot, { valueSI: 2.4 }]]), { group: 'unsure', reasons: ['conflict'] }],
    ['the same value held that day is already saved', lab({ values: [core()] }), new Map([[ldlSlot, { valueSI: 3.1 + 1e-12 }]]), { group: 'saved' }],
    ['a value with no known day is never slotted', lab({ values: [core({ recordedAt: UNDATED_PREVIOUS })] }), new Map([[ldlSlot, { valueSI: 2.4 }]]), { group: 'sure' }],
    ['a file with no day set yet slots nothing', lab({ values: [core()] }, null), new Map([[ldlSlot, { valueSI: 2.4 }]]), { group: 'sure' }],
    ['a catalogued lab in its unit is sure', lab({ additionalValues: [extra()] }), NONE, { group: 'sure' }],
    ['a known conversion is sure', lab({ additionalValues: [extra({ unit: 'ng/mL' })] }), NONE, { group: 'sure' }],
    ['a test not in the catalogue is sure (Q3 a)', lab({ additionalValues: [extra({ name: 'Mystery marker', unit: 'zz' })] }), NONE, { group: 'sure' }],
    ['a lab the model doubted asks for a look', lab({ additionalValues: [extra({ confidence: 'low' })] }), NONE, { group: 'unsure', reasons: ['confidence'] }],
    ['a different lab held that day is a conflict', lab({ additionalValues: [extra()] }), new Map([[ferritinSlot, { lab: { name: 'ferritin', value: 60, unit: 'µg/L' } }]]), { group: 'unsure', reasons: ['conflict'] }],
    ['the same lab held, in another spelling, is already saved', lab({ additionalValues: [extra({ unit: 'ng/mL' })] }), new Map([[ferritinSlot, { lab: { name: 'ferritin', value: 80, unit: 'µg/L' } }]]), { group: 'saved' }],
    ['a unit the test does not take', lab({ additionalValues: [extra({ unit: 'furlongs' })] }), NONE, { group: 'notSaved', reason: 'unit' }],
    ['no unit printed', lab({ additionalValues: [extra({ unit: '' })] }), NONE, { group: 'notSaved', reason: 'noUnit' }],
    ['past the plausible range', lab({ additionalValues: [extra({ name: 'Sodium', value: 1000, unit: 'mmol/L' })] }), NONE, { group: 'notSaved', reason: 'misread' }],
    ['past the ceiling a prefix step reaches', lab({ additionalValues: [extra({ name: 'Reticulocytes', value: 5, unit: '×10¹²/L' })] }), NONE, { group: 'notSaved', reason: 'misread' }],
    ['a count per µL that is not whole', lab({ additionalValues: [extra({ name: 'WBC', value: 6.5, unit: 'cells/µL' })] }), NONE, { group: 'notSaved', reason: 'scale' }],
    ['a core test filed as a lab converts as core', lab({ additionalValues: [extra({ name: 'HbA1c', value: 40, unit: 'mmol/mol' })] }), NONE, { group: 'sure' }],
    ['a core test filed as a lab in a unit it does not take', lab({ additionalValues: [extra({ name: 'HbA1c', value: 40, unit: 'furlongs' })] }), NONE, { group: 'notSaved', reason: 'unit' }],
    ['a creatinine with no unit', lab({ refusedValues: [{ metric: 'creatinine', value: 80, unit: '', reason: 'No unit was printed.' }] }), NONE, { group: 'notSaved', reason: 'noUnit' }],
    ['a creatinine in a urine unit', lab({ refusedValues: [{ metric: 'creatinine', value: 3, unit: 'mg/mmol', reason: 'x' }] }), NONE, { group: 'notSaved', reason: 'urine' }],
    ['a creatinine in an unknown unit', lab({ refusedValues: [{ metric: 'creatinine', value: 3, unit: 'zz', reason: 'x' }] }), NONE, { group: 'notSaved', reason: 'unit' }],
    ['an unreadable number', lab({ unreadValues: [{ name: 'tsh', reason: 'unreadable' }], droppedValueCount: 1 }), NONE, { group: 'notSaved', reason: 'unreadable' }],
  ])('%s', (_name, file, held, expected) => {
    expect(shape(one(file, held))).toEqual(expected);
  });

  it('collects every reason a value has, and names the test by its label, never a key', () => {
    const [v] = classifyImportValues([lab({ values: [core({ metric: 'lpa', confidence: 'low', question: 'Check the unit.', unitGuessed: true })] })], NONE);
    expect(v).toMatchObject({ group: 'unsure', reasons: ['confidence', 'question', 'unitGuessed'], label: 'Lp(a)', ref: 'v0', file: 0 });
    const [u] = classifyImportValues([lab({ unreadValues: [{ name: 'immature_granulocytes', reason: 'unreadable' }], droppedValueCount: 1 })], NONE);
    expect(u.label).toBe('Immature granulocytes');
  });

  it('a second reading of a test on a day the upload already filled is not saved; the first stands', () => {
    const files = [lab({ values: [core()] }), lab({ values: [core({ valueSI: 2.9, confidence: 'low' })] })];
    expect(classifyImportValues(files, NONE).map(shape)).toEqual([{ group: 'sure' }, { group: 'notSaved', reason: 'sameDay' }]);
  });

  it('counts dropped rows that name no test, and skips documents', () => {
    const files: ImportFile[] = [
      { result: { classification: 'clinic_letter', document: { classification: 'clinic_letter', title: 'Letter', documentDate: null, contentMarkdown: 'x', metadata: {} } }, day: null },
      lab({ unreadValues: [{ name: 'tsh', reason: 'unreadable' }, { name: '', reason: 'unreadable' }], droppedValueCount: 3 }),
    ];
    const all = classifyImportValues(files, NONE);
    expect(all.map((v) => [v.file, v.ref, v.label])).toEqual([[1, 'u0', 'TSH'], [1, 'u1', ''], [1, 'u2', '']]);
  });
});

describe('held slots: the record as the review compares against it', () => {
  it('reads the same slots from the file (iPhone) as from the history (web)', () => {
    let file = createEmptyFile({ deviceId: 'd', now: '2026-11-02T00:00:00Z' });
    file = bulkAppendValues(file, [
      { kind: 'measurement', metricType: 'ldl', value: 2.4, recordedAt: DAY, source: 'manual' },
      { kind: 'lab', metricName: 'Ferritin', value: 60, unit: 'µg/L', recordedAt: DAY, source: 'manual' },
    ], '2026-11-02T00:00:00Z').file;
    const fromFile = heldSlotsFromFile(file);
    const fromHistory = heldSlots([{ metricType: 'ldl', value: 2.4, recordedAt: DAY }], [{ metricName: 'Ferritin', value: 60, unit: 'µg/L', recordedAt: DAY }]);
    const files = [lab({ values: [core()], additionalValues: [extra()] })];
    expect(classifyImportValues(files, fromFile).map(shape)).toEqual([{ group: 'unsure', reasons: ['conflict'] }, { group: 'unsure', reasons: ['conflict'] }]);
    expect(classifyImportValues(files, fromHistory).map(shape)).toEqual(classifyImportValues(files, fromFile).map(shape));
  });
});

describe('the review per D3 case', () => {
  const groups = (files: ImportFile[], held = NONE) => {
    const all = classifyImportValues(files, held);
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
    const held = new Map([[slotKey('measurement', 'ldl', DAY), { valueSI: 3.1 }]]);
    expect(groups([lab({ values: [core()] })], held)).toMatchObject({ sure: 0, unsure: 0, notSaved: 0, saved: 1 });
  });
});

describe('importSummaryText (strings 1 to 3)', () => {
  const doc = (classification: string): ImportFile => ({ result: { classification, document: { classification, title: 't', documentDate: null, contentMarkdown: '', metadata: {} } }, day: null });
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
    const groups = notSavedGroups(classifyImportValues(files, NONE));
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
    const groups = notSavedGroups(classifyImportValues([lab({ droppedValueCount: 1 })], NONE));
    expect(groups).toEqual({ total: 1, lines: [], other: '1 value could not be read' });
    const words = JSON.stringify(notSavedGroups(classifyImportValues([lab({ additionalValues: [extra({ name: 'immature_granulocytes', unit: 'zz' })] })], NONE)));
    expect(words).not.toMatch(/immature_granulocytes|Do not|Ask the person/);
  });
});

describe('IMPORT_REVIEW_TEXT (strings 4 to 14)', () => {
  it('counts in words', () => {
    expect(IMPORT_REVIEW_TEXT.checkTitle(3)).toBe('Check these 3 values');
    expect(IMPORT_REVIEW_TEXT.willSave(1)).toBe('1 value will be saved');
    expect(IMPORT_REVIEW_TEXT.showAll(12)).toBe('Show all 12');
    expect(IMPORT_REVIEW_TEXT.alreadySaved(2)).toBe('2 already in your record');
    expect(IMPORT_REVIEW_TEXT.save(12)).toBe('Save 12 values');
  });
});
