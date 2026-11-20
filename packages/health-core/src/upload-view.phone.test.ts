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
import { longDate, REFUSED_TEXT, REVIEW_CELL_TEXT } from './upload-text';
import { transition } from './upload-flow';
import type { ChoiceChange } from './upload-choices';
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

  it("the extractor's question as it was read; a guessed unit is a check, never called printed", () => {
    const rows = all(open([read('lab', labX({ values: [
      core({ confidence: 'medium', question: 'Was this a fasting test?' }),
      core({ metric: 'hdl', confidence: 'medium', unitGuessed: true, displayValue: 1.2, valueSI: 1.2 }),
    ] }))]));
    const byRef = Object.fromEntries(rows.map((r) => [r.ref, r]));
    expect(byRef.v0).toMatchObject({ question: 'Was this a fasting test?', unitNote: null });
    expect(byRef.v1).toMatchObject({ question: null, unitNote: 'Check this value and its unit against the report' });
    expect(Object.values(byRef).some((r) => 'printed' in r)).toBe(false);
  });

  it('every value shows the day it saves on: its own, else its report\'s, written as the web writes dates', () => {
    const rows = all(open([read('lab', labX({ values: [core(), core({ metric: 'hdl', recordedAt: '2026-06-01', displayValue: 1.2, valueSI: 1.2 })] }))]));
    expect(rows.map((r) => [r.ref, r.day, r.dayLine])).toEqual([['v0', DAY, '1 Nov 2026'], ['v1', '2026-06-01', '1 Jun 2026']]);
  });

  it('the same test in two reports on different days is told apart by its day (Codex re-check item 2)', () => {
    const v = viewOf(open([read('a', labX()), read('b', labX({ reportDate: '2026-09-15' }))]));
    const rows = v.sure?.rows ?? [];
    expect(rows.map((r) => [r.label, r.dayLine])).toEqual([['LDL Cholesterol', '1 Nov 2026'], ['LDL Cholesterol', '15 Sep 2026']]);
  });

  it('Replace is offered on a value whose day the record already holds, in the web\'s word', () => {
    const record = recordWith([{ kind: 'measurement', metricType: 'ldl', value: 2.0 }]);
    const s = open([read('lab', labX())]);
    const v = viewOf(s, record);
    const row = v.sections.flatMap((x) => (x.kind === 'unsure' ? x.rows : []))[0];
    expect(row).toMatchObject({ ref: 'v0', replace: 'Replace', replaceLabel: 'Replace the saved LDL Cholesterol value from 1 Nov 2026', replacing: false });
    expect(row.replaces).toBeTruthy();
    expect([row.value, row.unit, row.held]).toEqual(['3.1', 'mmol/L', '2 mmol/L']);
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
    expect(dated.documents?.rows[0]).toMatchObject({ kindKey: 'scan_result', kind: 'scan result', day: '2026-09-01', date: '1 Sep 2026' });
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
      expect([v.phase, v.closeEnabled, v.doneLabel, v.editable]).toEqual([s.phase, close, 'Done', s.phase === 'open' || s.phase === 'saveFailed']);
    }
    expect(viewOf({ ...pick, phase: 'failed', refused: 'dailyLimit', files }).refused).toBe(REFUSED_TEXT.dailyLimit);
    expect(viewOf({ ...pick, phase: 'failed', refused: null, files }).refused).toBeNull();
  });

  it('the moved web words stay byte for byte', () => {
    expect(REVIEW_CELL_TEXT.printed(3.1, '')).toBe('Printed: 3.1 (no unit)');
    expect(REVIEW_CELL_TEXT.replace).toBe('Replace');
    expect(REVIEW_CELL_TEXT.replaceLabel('Iron', '5 Jan 2019')).toBe('Replace the saved Iron value from 5 Jan 2019');
    expect([longDate('2019-01-05'), longDate('2025-06'), longDate('undated:a')]).toEqual(['5 Jan 2019', 'Jun 2025', null]);
  });

  it('Replace selects its value through the engine, and clearing a value drops its Replace (Codex R3)', () => {
    const record = recordWith([{ kind: 'measurement', metricType: 'ldl', value: 2.0 }]);
    const s0 = open([read('lab', labX())]);
    const held = viewOf(s0, record).sections.flatMap((x) => (x.kind === 'unsure' ? x.rows : []))[0].replaces!;
    const step = (s: UploadState, change: ChoiceChange) => transition(s, { type: 'chose', id: 'lab', change, now: NOW }).state;
    const unticked = step(s0, { tick: 'v0', on: false });
    const replaced = step(unticked, { replace: 'v0', correctsId: held });
    const row = viewOf(replaced, record).sections.flatMap((x) => (x.kind === 'unsure' ? x.rows : []))[0];
    expect([row.ticked, row.replacing]).toEqual([true, true]);
    const cleared = viewOf(step(replaced, { tick: 'v0', on: false }), record).sections.flatMap((x) => (x.kind === 'unsure' ? x.rows : []))[0];
    expect([cleared.ticked, cleared.replacing]).toEqual([false, false]);
  });
});
