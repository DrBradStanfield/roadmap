/**
 * Web list PR 1d (US-13 AC5, AC10, AC26, 2026-11-21): what the first draft of the list screen (PR 1948) needed and the
 * ledger did not expose. Why a row needs checking; the "check these" heading; each row's accessible name and its Replace
 * label; each day control's words. Existing words only. Synthetic values only.
 */
import { describe, expect, it } from 'vitest';
import { core, DAY, EMPTY, extra, NOW } from './import-review.test-helpers';
import { IMPORT_REVIEW_TEXT } from './import-review';
import { UNDATED_PREVIOUS, type UnifiedExtractionResult } from './lab-extraction';
import { bulkAppendValues } from './record-edits';
import type { RoadmapFile } from './roadmap-file';
import { NO_CHOICES, type ChoiceChange } from './upload-choices';
import { transition, type UploadState } from './upload-flow';
import { uploadList } from './upload-list';
import { uploadReview } from './upload-review';
import { DAY_CONTROL_TEXT, REVIEW_CELL_TEXT, UPLOAD_TEXT } from './upload-text';

type Open = Extract<UploadState, { phase: 'open' }>;
const labRead = (id: string, over: Partial<UnifiedExtractionResult>, name = `${id}.pdf`): Open['files'][number] => ({
  id, name, bytes: 1, hash: `h-${id}`, pages: { count: 1, truncated: false },
  status: { s: 'read', extraction: { classification: 'lab_report', reportDate: DAY, values: [], additionalValues: [], unrecognized: [], document: null, ...over }, choices: NO_CHOICES },
});
const open = (files: Open['files']): Open => ({ phase: 'open', platform: 'web', run: 1, files, started: NOW, firstRead: NOW });
const list = (s: UploadState, record: RoadmapFile = EMPTY) => uploadList(s, record, NOW, uploadReview(s, record, NOW), () => 'si');
const chose = (s: UploadState, id: string, change: ChoiceChange) => transition(s, { type: 'chose', id, change, now: NOW }).state;
const hba1c = (over = {}) => core({ metric: 'hba1c', valueSI: 40, displayValue: 40, displayUnit: 'mmol/mol', ...over });

describe('why a row needs checking (US-13 AC26)', () => {
  it('the extractor\'s question and the guessed-unit note, as the iPhone shows them, beside the caption', () => {
    const rows = list(open([labRead('f0', { values: [core({ question: 'Is this LDL?' }), hba1c({ unitGuessed: true }), core({ metric: 'hba1c', valueSI: 52, displayValue: 52, displayUnit: 'mmol/mol', recordedAt: '2026-10-01', question: 'Fasting?', unitGuessed: true })] })])).rows;
    expect(rows.map((r) => [r.status.kind, r.caption, r.reasons])).toEqual([
      ['check', null, ['Is this LDL?']],
      ['check', null, [REVIEW_CELL_TEXT.checkUnit]],
      ['check', null, ['Fasting?', REVIEW_CELL_TEXT.checkUnit]],
    ]);
  });

  it('a row with no question and a read unit carries no reasons; a waiting row keeps its question', () => {
    const rows = list(open([labRead('f0', { reportDate: null, values: [core({ question: 'Is this LDL?' })], additionalValues: [extra({})] })])).rows;
    expect(rows.map((r) => [r.status.kind, r.reasons])).toEqual([['waits', ['Is this LDL?']], ['waits', []]]);
  });

  // confidenceUnworded, closed (owner ruling 2026-11-21, option b, no new words): a value unsure only for its read's
  // confidence has no words of its own, so the group carries the review's footer as its note under the heading.
  it('confidenceUnworded, closed: a low-confidence value has no words of its own, and the group note says why', () => {
    const l = list(open([labRead('f0', { values: [core({ confidence: 'medium' })] })]));
    expect(l.rows[0]).toMatchObject({ status: { kind: 'check', reasons: ['confidence'] }, attention: true, caption: null, reasons: [], error: null });
    expect(l.checkNote).toBe(IMPORT_REVIEW_TEXT.checkFooter);
    expect(IMPORT_REVIEW_TEXT.checkFooter).toBe('We were not sure about these. Check each against the report.');
  });

  it('no group note while every unsure row says why itself, or none is unsure', () => {
    expect(list(open([labRead('f0', { values: [core({ question: 'Is this LDL?' }), hba1c({ unitGuessed: true })] })])).checkNote).toBeNull();
    expect(list(chose(open([labRead('f0', { values: [core({})] })]), 'f0', { tick: 'v0', on: false })).checkNote).toBeNull();
  });
});

describe('the "check these" heading (US-13 AC26)', () => {
  // Owner ruling on PR 1949 review (G2): the first group and the heading are two things. A row the person touched stays
  // in the first group, never hidden, but the heading counts only the rows that need checking.
  it('counts the rows that need checking; a row only touched shows before "Show all" but is not counted', () => {
    let s: UploadState = open([labRead('f0', { values: [core({ question: 'Is this LDL?' }), hba1c(), core({ valueSI: 2.4, displayValue: 2.4, recordedAt: '2026-10-01' })] })]);
    s = chose(s, 'f0', { tick: 'v1', on: false });
    const l = list(s);
    expect(l.rows.map((r) => r.attention)).toEqual([true, true, false]);
    expect(l.check).toBe(IMPORT_REVIEW_TEXT.checkTitle(1));
    expect(l.showAll).toBe(IMPORT_REVIEW_TEXT.showAll(1));
  });

  it('no heading when no row needs checking, even while a touched row shows', () => {
    const l = list(open([labRead('f0', { values: [core({})] })]));
    expect(l.check).toBeNull();
    expect(l.showAll).toBe(IMPORT_REVIEW_TEXT.showAll(1));
    const touched = list(chose(open([labRead('f0', { values: [core({}), hba1c()] })]), 'f0', { tick: 'v0', on: false }));
    expect(touched).toMatchObject({ check: null, showAll: IMPORT_REVIEW_TEXT.showAll(1) });
    expect(touched.rows.map((r) => r.attention)).toEqual([true, false]);
  });
});

// Owner ruling on PR 1949 review (G1): a row with a reason is shown before "Show all" whenever the person can still act on
// it for this Save: every status but "already in your record" and a not-saved reason no change of theirs can lift (its
// unit, no unit, a urine unit, unreadable, its own day still to come).
describe('a row with a reason the person can act on is never hidden (US-13 AC26)', () => {
  it('an undated report\'s value with a guessed unit waits for its day, and needs attention', () => {
    const l = list(open([labRead('f0', { reportDate: null, values: [core({ unitGuessed: true })] })]));
    expect(l.rows[0]).toMatchObject({ status: { kind: 'waits' }, reasons: [REVIEW_CELL_TEXT.checkUnit], attention: true });
    expect(l.check).toBe(IMPORT_REVIEW_TEXT.checkTitle(1));
  });

  it('a value already in the record, or one whose unit the write refuses, keeps its reason but sits behind "Show all"', () => {
    const record = bulkAppendValues(EMPTY, [{ kind: 'measurement', metricType: 'ldl', value: 3.1, recordedAt: DAY, source: 'manual' }], NOW).file;
    const l = list(open([labRead('f0', { values: [core({ question: 'Is this LDL?', confidence: 'high' })], additionalValues: [extra({ unit: 'zzz', question: 'Ferritin?' })] })]), record);
    expect(l.rows.map((r) => [r.status.kind, r.reasons, r.attention])).toEqual([
      ['alreadyInRecord', ['Is this LDL?'], false],
      ['notSaved', ['Ferritin?'], false],
    ]);
    expect(l.check).toBeNull();
  });
});

describe('each row\'s accessible name and its Replace label (US-13 AC10)', () => {
  it('"<test> value from <file>, <day>"; a later reading there adds "another reading"; the day left out while none', () => {
    const s = open([
      labRead('f0', { values: [core({}), core({ valueSI: 3.5, displayValue: 3.5 }), hba1c()] }),
      labRead('f1', { values: [core({})] }),
      labRead('f2', { reportDate: null, values: [core({})] }),
    ]);
    expect(list(s).rows.map((r) => r.name)).toEqual([
      'LDL Cholesterol value from f0.pdf, 1 Nov 2026',
      'LDL Cholesterol value from f0.pdf, 1 Nov 2026, another reading',
      'HbA1c value from f0.pdf, 1 Nov 2026',
      'LDL Cholesterol value from f1.pdf, 1 Nov 2026',
      'LDL Cholesterol value from f2.pdf',
    ]);
  });

  it('two files of one name: the second file\'s reading is "another reading"', () => {
    const names = list(open([labRead('f0', { values: [core({})] }, 'lab.pdf'), labRead('f1', { values: [core({})] }, 'lab.pdf')])).rows.map((r) => r.name);
    expect(new Set(names).size).toBe(2);
  });

  // KNOWN thirdReadingShared (Needs Brad): a third reading of one test in one file name on one day shares the second's
  // name; no ordinal words exist yet.
  it('KNOWN thirdReadingShared: the third reading shares the second\'s name', () => {
    const names = list(open([labRead('f0', { values: [core({}), core({ valueSI: 3.5, displayValue: 3.5 }), core({ valueSI: 3.7, displayValue: 3.7 })] })])).rows.map((r) => r.name);
    expect(names[1]).toBe(names[2]);
  });

  // KNOWN replaceLabelShared (owner ruling on PR 1949 review, G4; property seeds 7, 11, 31, 35, 44): two reports holding
  // one test on one day the record already has both replace that saved value, so their Replace labels, which name it, are
  // the same. The screen ties each Replace control to its row's distinct `name`.
  it('KNOWN replaceLabelShared: two files\' conflicts on one test and day share the Replace label, never the row name', () => {
    const record = bulkAppendValues(EMPTY, [{ kind: 'measurement', metricType: 'ldl', value: 2.0, recordedAt: DAY, source: 'manual' }], NOW).file;
    // The second is cleared, so it takes no slot from the first and is previewed alone against the record.
    const s = chose(open([labRead('f0', { values: [core({})] }), labRead('f1', { values: [core({ valueSI: 3.5, displayValue: 3.5 })] })]), 'f1', { tick: 'v0', on: false });
    const rows = list(s, record).rows;
    expect(rows[0].replaceLabel).toBe(rows[1].replaceLabel);
    expect(rows[0].name).not.toBe(rows[1].name);
  });

  it('a conflict\'s Replace label names the test and the day in words; no Replace, no label', () => {
    const record = bulkAppendValues(EMPTY, [{ kind: 'measurement', metricType: 'ldl', value: 2.0, recordedAt: DAY, source: 'manual' }], NOW).file;
    const rows = list(open([labRead('f0', { values: [core({}), hba1c()] })]), record).rows;
    expect(rows.map((r) => r.replaceLabel)).toEqual([REVIEW_CELL_TEXT.replaceLabel('LDL Cholesterol', '1 Nov 2026'), null]);
    expect(rows[0].replaceLabel).toBe('Replace the saved LDL Cholesterol value from 1 Nov 2026');
  });
});

describe('each day control carries its words (US-12 AC14, US-13 AC24)', () => {
  it('the test day; the undated previous column with its limits while it has no day; a dated column', () => {
    const s = open([labRead('f0', { reportDate: null, values: [core({}), hba1c({ recordedAt: UNDATED_PREVIOUS }), core({ recordedAt: '2026-09-15' })] })]);
    const withMonth = open([labRead('f0', { values: [core({}), hba1c({ recordedAt: UNDATED_PREVIOUS, printedMonth: '2024-06' })] })]);
    expect(list(s).days.map((d) => [d.source, d.label, d.hint])).toEqual([
      ['test', UPLOAD_TEXT.dayOfTest, UPLOAD_TEXT.undatedTitle],
      ['previous', DAY_CONTROL_TEXT.previous, 'Pick a day'],
      ['column', DAY_CONTROL_TEXT.previous, null],
    ]);
    expect(list(s).days[2]).toMatchObject({ source: 'column', printed: '2026-09-15', printedLine: '15 Sep 2026' });
    expect(list(withMonth).days.find((d) => d.source === 'previous')?.hint).toBe('Pick a day in Jun 2024 before 1 Nov 2026');
    const picked = list(chose(chose(s, 'f0', { testDay: '2026-10-20' }), 'f0', { previousDay: '2026-09-01' })).days;
    expect(picked.map((d) => d.hint)).toEqual([null, null, null]);
  });

  it('two dated columns of one file share the label and are told apart by the day each printed, in words', () => {
    const days = list(open([labRead('f0', { values: [core({ recordedAt: '2026-09-15' }), core({ recordedAt: '2026-08-02' })] })])).days;
    expect(days.map((d) => [d.label, d.source === 'column' ? d.printedLine : null])).toEqual([
      [DAY_CONTROL_TEXT.previous, '15 Sep 2026'], [DAY_CONTROL_TEXT.previous, '2 Aug 2026'],
    ]);
  });

  // Owner ruling on PR 1949 review (G3): each control carries its file's name as rows show it, and a ready-made name.
  it('each control names its file as the rows do, a ZIP member by its path, and carries its whole accessible name', () => {
    const member = { ...labRead('f1', { values: [core({}), core({ recordedAt: '2026-09-15' })] }, 'scans/report.pdf'), zip: 'labs.zip' };
    const days = list(open([labRead('f0', { reportDate: null, values: [core({})] }), member])).days;
    expect(days.map((d) => [d.fileName, d.name])).toEqual([
      ['f0.pdf', 'Day of the test, f0.pdf'],
      ['labs.zip/scans/report.pdf', 'Day of the test, labs.zip/scans/report.pdf'],
      ['labs.zip/scans/report.pdf', 'Choose the date of the previous results, 15 Sep 2026, labs.zip/scans/report.pdf'],
    ]);
    expect(list(open([member])).rows[0].name).toBe('LDL Cholesterol value from labs.zip/scans/report.pdf, 1 Nov 2026');
  });

  it('the words moved from the web\'s grid, byte for byte', () => {
    expect(DAY_CONTROL_TEXT.previous).toBe('Choose the date of the previous results');
    expect(DAY_CONTROL_TEXT.column).toBe('Choose column date');
    expect(DAY_CONTROL_TEXT.pickDay('2024-06', '2026-03-10')).toBe('Pick a day in Jun 2024 before 10 Mar 2026');
    expect(DAY_CONTROL_TEXT.pickDay(null, '2026-03-10')).toBe('Pick a day before 10 Mar 2026');
    expect(DAY_CONTROL_TEXT.pickDay(null, null)).toBe('Pick a day');
  });
});
