/**
 * Web list PR 1e (US-13 AC5, AC26, US-02, 2026-11-21): four more things the list screen (PR 1948) needed and the engine
 * did not expose. A row's unit control, and the unit beside held text; what a day control's picker shows and why it still
 * waits; each letter's text for its preview; the Save and close buttons' words in every phase. Existing words only.
 * Synthetic values only.
 */
import { describe, expect, it } from 'vitest';
import { core, DAY, EMPTY, extra, NOW } from './import-review.test-helpers';
import { UNDATED_PREVIOUS, type UnifiedExtractionResult } from './lab-extraction';
import { DAY_NOT_HAPPENED } from './lab-series';
import type { RoadmapFile } from './roadmap-file';
import type { CellUnit } from './cell-unit';
import { NO_CHOICES, type ChoiceChange } from './upload-choices';
import { initialUpload, transition, type UploadState } from './upload-flow';
import { uploadList } from './upload-list';
import { uploadListPage } from './upload-list-page';
import { uploadSavePlan } from './upload-plan';
import { uploadReview } from './upload-review';
import { DAY_CONTROL_TEXT, UPLOAD_TEXT } from './upload-text';
import { uploadView } from './upload-view';
import type { MetricType } from './units';

type Open = Extract<UploadState, { phase: 'open' }>;
type File = Open['files'][number];
const labRead = (id: string, over: Partial<UnifiedExtractionResult>): File => ({
  id, name: `${id}.pdf`, bytes: 1, hash: `h-${id}`, pages: { count: 1, truncated: false },
  status: { s: 'read', extraction: { classification: 'lab_report', reportDate: DAY, values: [], additionalValues: [], unrecognized: [], document: null, ...over }, choices: NO_CHOICES },
});
/** `contentMarkdown` undefined: a read whose answer carried none (the schema requires it; Save files it as empty). */
const letterRead = (id: string, contentMarkdown?: string): File => ({
  id, name: `${id}.pdf`, bytes: 1, hash: `h-${id}`, pages: { count: 1, truncated: false },
  status: { s: 'read', extraction: { classification: 'clinic_letter', reportDate: null, values: [], additionalValues: [], unrecognized: [], document: { classification: 'clinic_letter', title: 'A letter', documentDate: '2026-10-20', contentMarkdown: contentMarkdown as string, metadata: {} } }, choices: NO_CHOICES },
});
const open = (files: Open['files']): Open => ({ phase: 'open', platform: 'web', run: 1, files, started: NOW, firstRead: NOW });
const list = (s: UploadState, unitOf: (m: MetricType) => CellUnit = () => 'si', record: RoadmapFile = EMPTY) => uploadList(s, record, NOW, uploadReview(s, record, NOW), unitOf);
const chose = (s: UploadState, id: string, change: ChoiceChange) => transition(s, { type: 'chose', id, change, now: NOW }).state;
const page = (s: UploadState, cloud = false) => uploadListPage(s, EMPTY, NOW, uploadReview(s, EMPTY, NOW), cloud);
const lpa = (over = {}) => core({ metric: 'lpa', valueSI: 120, displayValue: 120, displayUnit: 'nmol/L', ...over });
const sbp = () => core({ metric: 'systolic_bp' as never, valueSI: 120, displayValue: 120, displayUnit: 'mmHg' });

describe('1. a row\'s unit control (US-13 AC26, US-02)', () => {
  it('a two-unit test offers a toggle to the other unit; the label is the unit shown', () => {
    const s = open([labRead('f0', { values: [core({})] })]);
    expect(list(s, () => 'si').rows[0].unit).toEqual({ label: 'mmol/L', typeIn: 'si', toggle: 'conventional', choices: null, current: null });
    expect(list(s, () => 'conventional').rows[0].unit).toEqual({ label: 'mg/dL', typeIn: 'conventional', toggle: 'si', choices: null, current: null });
  });

  it('Lp(a) offers its three units to choose from, no toggle; its label is the unit chosen', () => {
    const s = open([labRead('f0', { values: [lpa()] })]);
    expect(list(s, (m) => (m === 'lpa' ? 'mg/L' : 'si')).rows[0].unit).toEqual({ label: 'mg/L', typeIn: 'mg/L', toggle: null, choices: ['nmol/L', 'mg/dL', 'mg/L'], current: 'mg/L' });
  });

  it('a fixed unit, a lab and a core metric this build does not know offer no control', () => {
    const s = open([labRead('f0', { values: [sbp(), core({ metric: 'mystery' as never, valueSI: 5, displayValue: 5, displayUnit: 'zz' })], additionalValues: [extra({})] })]);
    expect(list(s).rows.map((r) => r.unit)).toEqual([
      { label: 'mmHg', typeIn: 'si', toggle: null, choices: null, current: null },
      { label: 'zz', typeIn: null, toggle: null, choices: null, current: null },
      { label: 'µg/L', typeIn: null, toggle: null, choices: null, current: null },
    ]);
  });

  // Owner ruling on PR 1951: a row holding text offers no unit control (fix or clear the text first); the test's other
  // rows keep theirs, and the held row's label stays at the unit typed.
  it('held text keeps the unit it was typed in beside it and offers no toggle; another row of the test keeps its own (AC5)', () => {
    const s = chose(open([labRead('f0', { values: [core({}), core({ valueSI: 2.4, displayValue: 2.4, recordedAt: '2026-10-01' })] })]), 'f0', { typed: 'v0', text: 'abc', unit: 'conventional' });
    for (const shows of ['si', 'conventional'] as const) {
      const [row, other] = list(s, () => shows).rows;
      expect(row.typed).toEqual({ text: 'abc', unit: 'conventional' });
      expect(row.unit).toMatchObject({ label: 'mg/dL', typeIn: 'conventional' });
      expect(row.unit).toMatchObject({ toggle: null, choices: null });
      expect(other.unit).toEqual({ label: shows === 'si' ? 'mmol/L' : 'mg/dL', typeIn: shows, toggle: shows === 'si' ? 'conventional' : 'si', choices: null, current: null });
    }
  });

  // Review H3: the screen marks the chosen Lp(a) unit from `current`, never by mapping a system unit itself.
  it('Lp(a)\'s current unit: unitOf\'s Lp(a) unit, or for a system the web\'s rule (US units mg/dL, else nmol/L); the shown number is in it', () => {
    const s = open([labRead('f0', { values: [lpa()] })]);
    const cases: Array<[CellUnit, string]> = [['nmol/L', 'nmol/L'], ['mg/dL', 'mg/dL'], ['mg/L', 'mg/L'], ['si', 'nmol/L'], ['conventional', 'mg/dL']];
    for (const [unit, current] of cases) {
      const row = list(s, () => unit).rows[0];
      expect([unit, row.unit.current, row.shown.unit]).toEqual([unit, current, current]);
      expect(row.unit.choices).toContain(row.unit.current);
    }
  });

  it('held Lp(a) text typed in mg/dL keeps mg/dL beside it while the person reads nmol/L', () => {
    const s = chose(open([labRead('f0', { values: [lpa()] })]), 'f0', { typed: 'v0', text: '1,2,3', unit: 'mg/dL' });
    expect(list(s, () => 'si').rows[0].unit).toEqual({ label: 'mg/dL', typeIn: 'mg/dL', toggle: null, choices: null, current: 'nmol/L' });
  });
});

describe('2. a day control\'s picker and words (US-13 AC24, AC26)', () => {
  it('a test day picked in the future: the picker shows the pick, and the control says that day has not happened', () => {
    const s = chose(open([labRead('f0', { reportDate: null, values: [core({})] })]), 'f0', { testDay: '2026-12-01' });
    expect(list(s).days[0]).toMatchObject({ chosen: '2026-12-01', day: null, picker: '2026-12-01', hint: DAY_NOT_HAPPENED });
  });

  it('a column day picked on the test\'s day waits: the picker shows it, and the control names its limit', () => {
    const s = chose(open([labRead('f0', { values: [core({ recordedAt: '2026-09-15' })] })]), 'f0', { columnDay: '2026-09-15', day: DAY });
    expect(list(s).days[0]).toMatchObject({ source: 'column', chosen: DAY, day: null, picker: DAY, hint: DAY_CONTROL_TEXT.pickDay(null, DAY) });
  });

  it('a column day picked in the future says that day has not happened', () => {
    const s = chose(open([labRead('f0', { values: [core({ recordedAt: '2026-09-15' })] })]), 'f0', { columnDay: '2026-09-15', day: '2026-12-01' });
    expect(list(s).days[0]).toMatchObject({ chosen: '2026-12-01', day: null, picker: '2026-12-01', hint: DAY_NOT_HAPPENED });
  });

  it('an undated previous column picked on the report\'s day names its limits; a partial pick shows nothing in the picker', () => {
    const base = open([labRead('f0', { values: [core({ recordedAt: UNDATED_PREVIOUS, printedMonth: '2026-10' })] })]);
    expect(list(chose(base, 'f0', { previousDay: DAY })).days[0]).toMatchObject({ chosen: DAY, day: null, picker: DAY, hint: DAY_CONTROL_TEXT.pickDay('2026-10', DAY) });
    expect(list(chose(base, 'f0', { previousDay: '2026-10' })).days[0]).toMatchObject({ chosen: '2026-10', day: null, picker: null, hint: DAY_CONTROL_TEXT.pickDay('2026-10', DAY) });
  });

  // Review H2: a report printed on a day still to come, with no pick, has a date, one that has not happened.
  it('a report printed on a day to come, no pick: the picker shows the printed day, and that day has not happened', () => {
    const s = open([labRead('f0', { reportDate: '2026-12-15', values: [core({})] })]);
    expect(list(s).days[0]).toMatchObject({ chosen: null, day: null, picker: '2026-12-15', hint: DAY_NOT_HAPPENED });
  });

  // KNOWN phoneFutureReportDate (lead): the iPhone's page, unchanged, still titles that report "This report has no date".
  it('KNOWN phoneFutureReportDate: the phone\'s view still says "This report has no date" for a report printed on a day to come', () => {
    const s: UploadState = { ...open([labRead('f0', { reportDate: '2026-12-15', values: [core({})] })]), platform: 'phone' };
    const section = uploadView(s, EMPTY, NOW, uploadReview(s, EMPTY, NOW), false).sections.find((x) => x.kind === 'undated');
    expect(section).toMatchObject({ title: UPLOAD_TEXT.undatedTitle, chosen: null });
  });

  it('with a day, the picker shows it and no words; with none and no pick, the asking words as before', () => {
    expect(list(open([labRead('f0', { values: [core({})] })])).days[0]).toMatchObject({ day: DAY, picker: DAY, hint: null });
    expect(list(open([labRead('f0', { values: [core({ recordedAt: '2026-09-15' })] })])).days[0]).toMatchObject({ chosen: null, day: '2026-09-15', picker: '2026-09-15', hint: null });
    expect(list(open([labRead('f0', { reportDate: null, values: [core({})] })])).days[0]).toMatchObject({ chosen: null, day: null, picker: null, hint: UPLOAD_TEXT.undatedTitle });
  });
});

describe('3. each letter\'s text for its preview (US-14 AC11-13)', () => {
  it('is the text Save writes, as the plan has it, in the view\'s order', () => {
    const s = open([letterRead('d0', '## Plan\n\nWalk daily.'), labRead('f0', { values: [core({})] }), letterRead('d1')]);
    const review = uploadReview(s, EMPTY, NOW);
    expect(page(s).letters).toEqual([{ fileId: 'd0', text: '## Plan\n\nWalk daily.', preview: '## Plan\n\nWalk daily.', pickerLine: '20 Oct 2026' }, { fileId: 'd1', text: '', preview: '', pickerLine: '20 Oct 2026' }]);
    expect(page(s).letters.map((l) => l.fileId)).toEqual(uploadView(s, EMPTY, NOW, review, false).documents!.rows.map((d) => d.fileId));
  });

  it('follows the person\'s title, kind and date fixes as the plan does: the text never changes with them', () => {
    let s: UploadState = open([letterRead('d0', '<b>not html</b>')]);
    for (const fix of [{ title: 'Renamed' }, { kind: 'scan_result' }, { date: null }, { date: '2026-10-01' }]) s = chose(s, 'd0', { document: fix });
    const plan = uploadSavePlan(s, EMPTY, NOW, uploadReview(s, EMPTY, NOW), false);
    expect(plan.documents[0].fields.title).toBe('Renamed');
    expect(page(s).letters).toEqual([{ fileId: 'd0', text: '<b>not html</b>', preview: '<b>not html</b>', pickerLine: '1 Oct 2026' }]);
  });

  it('two picks of the same bytes preview once, as Save files them once', () => {
    const twin = { ...letterRead('d1', 'B'), hash: 'h-d0' };
    expect(page(open([letterRead('d0', 'A'), twin])).letters).toEqual([{ fileId: 'd0', text: 'A', preview: 'A', pickerLine: '20 Oct 2026' }]);
  });
});

describe('4. the Save and close buttons\' words (moved from ReviewTable.tsx and UploadModal.tsx)', () => {
  const s = open([labRead('f0', { values: [core({})] })]);
  it('Save says the view\'s label, and "Saving..." while saving; close says "Cancel" while there is something to save', () => {
    const review = uploadReview(s, EMPTY, NOW);
    expect(page(s)).toMatchObject({ save: uploadView(s, EMPTY, NOW, review, false).save.label, close: 'Cancel' });
    const saving = transition(s, { type: 'saveStarted', reviewed: uploadView(s, EMPTY, NOW, review, false).reviewed }).state;
    expect(saving.phase).toBe('saving');
    expect(page(saving)).toMatchObject({ save: 'Saving...', close: 'Cancel' });
  });

  // US-12 AC6: "its indicator distinguishes saving". The shared view's label is the one the iPhone draws on its Save button.
  it('US-12 AC6: the shared view\'s Save label is "Saving..." while saving, on the phone and the web, and the pre-save words otherwise', () => {
    for (const platform of ['phone', 'web'] as const) {
      const before = { ...s, platform };
      const review = uploadReview(before, EMPTY, NOW);
      const label = uploadView(before, EMPTY, NOW, review, false).save.label;
      expect(label, platform).toBe('Save 1 value');
      const saving = transition(before, { type: 'saveStarted', reviewed: uploadView(before, EMPTY, NOW, review, false).reviewed }).state;
      expect(uploadView(saving, EMPTY, NOW, uploadReview(saving, EMPTY, NOW), false).save.label, platform).toBe(UPLOAD_TEXT.saving);
    }
  });

  it('close says "Close" when nothing could be saved, "Cancel" while a value is offered though cleared, and while a file is read', () => {
    expect(page(open([labRead('f0', {})])).close).toBe('Close');
    expect(page(chose(s, 'f0', { tick: 'v0', on: false })).close).toBe('Cancel');
    const reading = open([{ id: 'f1', name: 'f1.pdf', bytes: 1, hash: 'h-f1', pages: { count: 1, truncated: false }, status: { s: 'sending', attempt: 1 } }]);
    expect(page(reading).close).toBe('Cancel');
  });

  it('the words are the web\'s, byte for byte', () => {
    expect([UPLOAD_TEXT.saving, UPLOAD_TEXT.cancel, UPLOAD_TEXT.close]).toEqual(['Saving...', 'Cancel', 'Close']);
  });

  // Owner ruling on PR 1951: one source per phase. While saving the review's close button still shows, disabled
  // (the web's old ReviewTable.tsx, gone in mount 3b); once done, the done screen's own button.
  it('close in every phase', () => {
    const review = uploadReview(s, EMPTY, NOW);
    const reviewed = uploadView(s, EMPTY, NOW, review, false).reviewed;
    const saving = transition(s, { type: 'saveStarted', reviewed }).state;
    const outcome = { values: 1, documents: 0, archived: 0, unstored: 0 } as never;
    const phases: Array<[UploadState, string]> = [
      [initialUpload('web'), 'Close'],
      [{ ...s, phase: 'consent' } as UploadState, 'Cancel'],
      [s, 'Cancel'],
      [open([labRead('f0', {})]), 'Close'],
      [saving, 'Cancel'],
      [{ ...s, phase: 'saveFailed', attempt: 1, message: 'The cloud refused the write.' }, 'Cancel'],
      [{ ...s, phase: 'done', outcome }, 'Done'],
      [{ ...s, phase: 'failed', refused: 'server' }, 'Cancel'],
      [{ ...open([labRead('f0', {})]), phase: 'failed', refused: 'server' }, 'Close'],
    ];
    expect(phases.map(([state]) => [state.phase, page(state).close])).toEqual(phases.map(([state, close]) => [state.phase, close]));
    expect(page({ ...s, phase: 'done', outcome }).close).toBe(uploadView({ ...s, phase: 'done', outcome }, EMPTY, NOW, review, false).doneLabel);
  });
});
