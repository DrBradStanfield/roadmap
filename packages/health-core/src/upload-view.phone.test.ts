/**
 * The view fields the iPhone's one review page draws from (design PR 15, US-52 AC8c; owner rulings
 * 2026-11-20 Q1 (a), Q2 (a)): each value with its printed number and unit, its question, its own
 * day, the Replace control's word; the documents' kind choices, machine day and date buttons; Hide;
 * an undated report's picker button; the machine's phase, a whole run's refusal, whether Close may
 * leave, and the Done word. Every string is an approved row or a web string moved byte for byte.
 * Synthetic values.
 */
import { describe, expect, it } from 'vitest';
import { core, DAY, EMPTY, extra, NOW, recordWith } from './import-review.test-helpers';
import type { UnifiedExtractionResult } from './lab-extraction';
import type { FileChoices } from './upload-choices';
import type { UploadFile, UploadState } from './upload-flow';
import { uploadReview } from './upload-review';
import { REFUSED_TEXT, REVIEW_CELL_TEXT } from './upload-text';
import { uploadView } from './upload-view';
import type { RoadmapFile } from './roadmap-file';

const viewOf = (s: UploadState, record: RoadmapFile = EMPTY) => uploadView(s, record, NOW, uploadReview(s, record, NOW), true);
const CHOICES: FileChoices = { ticks: {}, testDay: null, previousDay: null, replace: {}, edits: {}, document: {} };
const labX = (over: Partial<UnifiedExtractionResult> = {}): UnifiedExtractionResult =>
  ({ classification: 'lab_report', reportDate: DAY, values: [core()], additionalValues: [], unrecognized: [], document: null, ...over });
const read = (id: string, extraction: UnifiedExtractionResult, choices = CHOICES): UploadFile =>
  ({ id, name: `${id}.pdf`, bytes: 1, hash: `h-${id}`, pages: { count: 1, truncated: false }, status: { s: 'read', extraction, choices } });
const pick = { platform: 'phone' as const, run: 1, started: NOW, firstRead: null };
const open = (files: UploadFile[]): UploadState => ({ ...pick, phase: 'open', files });
const all = (s: UploadState) => {
  const v = viewOf(s);
  return [...v.sections.flatMap((x) => (x.kind === 'unsure' ? x.rows : [])), ...(v.sure?.rows ?? [])];
};

describe('upload view for the phone: each value as the report printed it', () => {
  it('the number with its limit sign and its unit, core and other lab tests alike', () => {
    const rows = all(open([read('lab', labX({ values: [core({ comparator: '<', displayValue: 0.6, valueSI: 0.6 })], additionalValues: [extra()] }))]));
    expect(rows.map((r) => [r.ref, r.value, r.unit])).toEqual([['v0', '< 0.6', 'mmol/L'], ['a0', '80', 'µg/L']]);
  });

  it("the extractor's question as it was read, and the web's printed line only for a guessed unit", () => {
    const rows = all(open([read('lab', labX({ values: [
      core({ confidence: 'medium', question: 'Was this a fasting test?' }),
      core({ metric: 'hdl', confidence: 'medium', unitGuessed: true, displayValue: 1.2, valueSI: 1.2 }),
    ] }))]));
    const byRef = Object.fromEntries(rows.map((r) => [r.ref, r]));
    expect(byRef.v0).toMatchObject({ question: 'Was this a fasting test?', printed: null });
    expect(byRef.v1).toMatchObject({ question: null, printed: 'Printed: 1.2 mmol/L' });
  });

  it("a value's own day only when it is not the report's; an undated previous column has none", () => {
    const rows = all(open([read('lab', labX({ values: [core(), core({ metric: 'hdl', recordedAt: '2026-06-01', displayValue: 1.2, valueSI: 1.2 })] }))]));
    expect(rows.map((r) => [r.ref, r.day])).toEqual([['v0', null], ['v1', '2026-06-01']]);
  });

  it('Replace is offered on a value whose day the record already holds, in the web\'s word', () => {
    const record = recordWith([{ kind: 'measurement', metricType: 'ldl', value: 2.0 }]);
    const s = open([read('lab', labX())]);
    const v = viewOf(s, record);
    const row = v.sections.flatMap((x) => (x.kind === 'unsure' ? x.rows : []))[0];
    expect(row).toMatchObject({ ref: 'v0', replace: 'Replace', replacing: false });
    expect(row.replaces).toBeTruthy();
  });
});

describe('upload view for the phone: documents, Hide and an undated report', () => {
  const letter: UnifiedExtractionResult = {
    classification: 'clinic_letter', reportDate: null, values: [], additionalValues: [], unrecognized: [],
    document: { classification: 'clinic_letter', title: 'Cardiology letter', documentDate: null, contentMarkdown: '## Plan', metadata: {} },
  };

  it('every kind with its word, the row\'s kind and machine day, and the two date buttons', () => {
    const v = viewOf(open([read('l', letter)]));
    expect(v.documents?.kinds?.map((k) => k.word)).toEqual(['scan result', 'clinic letter', 'discharge summary', 'pathology report', 'vaccination record', 'other document']);
    expect(v.documents?.rows[0]).toMatchObject({ kindKey: 'clinic_letter', day: null, date: 'No date', dateKnown: false });
    expect([v.documents?.setDate, v.documents?.removeDate]).toEqual(['Set the date', 'Remove the date']);
    const dated = viewOf(open([read('l', letter, { ...CHOICES, document: { date: '2026-09-01', kind: 'scan_result' } })]));
    expect(dated.documents?.rows[0]).toMatchObject({ kindKey: 'scan_result', kind: 'scan result', day: '2026-09-01', date: '2026-09-01' });
  });

  it('Show all has its Hide; an undated report opens its picker from the approved words, no day assumed', () => {
    expect(viewOf(open([read('lab', labX())])).sure?.hide).toBe('Hide');
    const v = viewOf(open([read('u', labX({ reportDate: null }))]));
    expect(v.sections[0]).toMatchObject({ kind: 'undated', choose: 'Choose the day of the test' });
    expect(v.save.enabled).toBe(false);
  });
});

describe('upload view for the phone: the phase, so the page holds no mode', () => {
  it('each phase as the machine has it; Close waits only while saving; Done is the app\'s word', () => {
    const files = [read('lab', labX())];
    const cases: Array<[UploadState, boolean]> = [
      [{ ...pick, phase: 'consent', files }, true], [open(files), true], [{ ...pick, phase: 'saving', attempt: 1, files }, false],
      [{ ...pick, phase: 'saveFailed', attempt: 1, message: 'No', files }, true], [{ ...pick, phase: 'done', outcome: { values: 1, documents: 0, archived: 0 }, files }, true],
      [{ ...pick, phase: 'failed', refused: 'dailyLimit', files }, true],
    ];
    for (const [s, close] of cases) {
      const v = viewOf(s);
      expect([v.phase, v.closeEnabled, v.doneLabel]).toEqual([s.phase, close, 'Done']);
    }
    expect(viewOf({ ...pick, phase: 'failed', refused: 'dailyLimit', files }).refused).toBe(REFUSED_TEXT.dailyLimit);
    expect(viewOf({ ...pick, phase: 'failed', refused: null, files }).refused).toBeNull();
  });

  it('the moved web words stay byte for byte', () => {
    expect(REVIEW_CELL_TEXT.printed(3.1, '')).toBe('Printed: 3.1 (no unit)');
    expect(REVIEW_CELL_TEXT.replace).toBe('Replace');
  });
});
