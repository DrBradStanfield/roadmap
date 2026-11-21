/**
 * Web list PR 1f (US-13 AC10, AC11, AC26): three more things the list screen (PR 1948) composed itself and the engine now
 * hands it. A row's "Printed:" note, by the grid's rule (review-matrix.ts, moved here); each letter's preview, the grid's
 * cut (ReviewFileSections.tsx, moved here); the words each date button shows. Existing words only. Synthetic values only.
 */
import { describe, expect, it } from 'vitest';
import { core, DAY, EMPTY, extra, NOW } from './import-review.test-helpers';
import { UNDATED_PREVIOUS, type UnifiedExtractionResult } from './lab-extraction';
import type { CellUnit } from './cell-unit';
import { printedNote } from './cell-input';
import { NO_CHOICES, type ChoiceChange } from './upload-choices';
import { transition, type UploadState } from './upload-flow';
import { uploadList } from './upload-list';
import { letterPreview, uploadListPage } from './upload-list-page';
import { uploadReview } from './upload-review';
import { DAY_CONTROL_TEXT, longDate, UPLOAD_TEXT } from './upload-text';
import type { MetricType } from './units';

type Open = Extract<UploadState, { phase: 'open' }>;
type File = Open['files'][number];
const labRead = (id: string, over: Partial<UnifiedExtractionResult>): File => ({
  id, name: `${id}.pdf`, bytes: 1, hash: `h-${id}`, pages: { count: 1, truncated: false },
  status: { s: 'read', extraction: { classification: 'lab_report', reportDate: DAY, values: [], additionalValues: [], unrecognized: [], document: null, ...over }, choices: NO_CHOICES },
});
const letterRead = (id: string, contentMarkdown: string, documentDate: string | null = '2026-10-20'): File => ({
  id, name: `${id}.pdf`, bytes: 1, hash: `h-${id}`, pages: { count: 1, truncated: false },
  status: { s: 'read', extraction: { classification: 'clinic_letter', reportDate: null, values: [], additionalValues: [], unrecognized: [], document: { classification: 'clinic_letter', title: 'A letter', documentDate, contentMarkdown, metadata: {} } }, choices: NO_CHOICES },
});
const open = (files: Open['files']): Open => ({ phase: 'open', platform: 'web', run: 1, files, started: NOW, firstRead: NOW });
const list = (s: UploadState, unitOf: (m: MetricType) => CellUnit = () => 'si') => uploadList(s, EMPTY, NOW, uploadReview(s, EMPTY, NOW), unitOf);
const chose = (s: UploadState, id: string, change: ChoiceChange) => transition(s, { type: 'chose', id, change, now: NOW }).state;
const page = (s: UploadState) => uploadListPage(s, EMPTY, NOW, uploadReview(s, EMPTY, NOW), false);
/** Creatinine printed 1.5 mg/dL: 133 µmol/L in SI (the grid's own example, ReviewTable.units.test.tsx). */
const creatinine = (over = {}) => core({ metric: 'creatinine', valueSI: 133, displayValue: 1.5, displayUnit: 'mg/dL', displaySystem: 'conventional', ...over });

describe('1. the printed quantity (US-13 AC11)', () => {
  it('a converted value names what the report printed; shown in the printed unit, nothing', () => {
    const s = open([labRead('f0', { values: [creatinine()] })]);
    expect(list(s, () => 'si').rows[0].printed).toBe('Printed: 1.5 mg/dL');
    expect(list(s, () => 'conventional').rows[0].printed).toBeNull();
  });

  it('compares by number, as the grid does: "1.1 mg/dL" shown as "1.10" has no note', () => {
    const s = open([labRead('f0', { values: [creatinine({ valueSI: 97.24, displayValue: 1.1 })] })]);
    expect(list(s, () => 'conventional').rows[0].shown.number).toBe('1.10');
    expect(list(s, () => 'conventional').rows[0].printed).toBeNull();
  });

  it('a guessed unit names what was printed even when the number is the same; no unit printed says so', () => {
    const s = open([labRead('f0', { values: [core({ unitGuessed: true }), core({ unitGuessed: true, displayUnit: '', displayValue: 2.8, valueSI: 2.8 })] })]);
    expect(list(s).rows.map((r) => r.printed)).toEqual(['Printed: 3.1 mmol/L', 'Printed: 2.8 (no unit)']);
  });

  it('a lab value shows as printed and has no note; a core test this build does not know, none unless its unit was guessed', () => {
    const mystery = (over = {}) => core({ metric: 'mystery' as never, valueSI: 5, displayValue: 5, displayUnit: 'zz', ...over });
    const s = open([labRead('f0', { values: [mystery(), mystery({ unitGuessed: true })], additionalValues: [extra({})] })]);
    expect(list(s).rows.map((r) => r.printed)).toEqual([null, 'Printed: 5 zz', null]);
  });

  // The grid's note reads the value as read (review-matrix.ts `initialDisplay`), never the person's edit: it stays as it was.
  it('an edited value keeps the note the value as read has, as the grid does', () => {
    const s = open([labRead('f0', { values: [creatinine(), core({})] })]);
    const edited = chose(chose(s, 'f0', { typed: 'v0', text: '100', unit: 'si' }), 'f0', { typed: 'v1', text: '150', unit: 'conventional' });
    const rows = list(edited, () => 'si').rows;
    expect(rows.map((r) => r.shown.number)).toEqual(['100', '3.9']);
    expect(rows.map((r) => r.printed)).toEqual(['Printed: 1.5 mg/dL', null]);
  });

  it('printedNote is the grid\'s rule: by number, or a guessed unit', () => {
    expect(printedNote(creatinine(), 'si')).toBe('Printed: 1.5 mg/dL');
    expect(printedNote(creatinine(), 'conventional')).toBeNull();
    expect(printedNote(core({ comparator: '<', valueSI: 0.6, displayValue: 0.6 }), 'si')).toBeNull();
  });
});

describe('2. the letter preview (US-14 AC11)', () => {
  const x = (n: number) => 'x'.repeat(n);
  it('a letter of 300 characters or fewer previews whole, with no "..."; a longer one its first 300 and "..."', () => {
    const s = open([letterRead('d0', x(300)), letterRead('d1', `${x(300)}tail`), letterRead('d2', '')]);
    expect(page(s).letters.map((l) => [l.fileId, l.preview])).toEqual([['d0', x(300)], ['d1', `${x(300)}...`], ['d2', '']]);
    expect(page(s).letters[1].text).toBe(`${x(300)}tail`);
  });

  it('letterPreview is the grid\'s cut', () => {
    expect([letterPreview(x(299)), letterPreview(x(301))]).toEqual([x(299), `${x(300)}...`]);
  });
});

describe('3. the date buttons\' words (US-13 AC24, US-14 AC12)', () => {
  it('a day control shows its picker\'s day in words, else the grid\'s "—"', () => {
    expect(list(open([labRead('f0', { values: [core({})] })])).days[0]).toMatchObject({ picker: DAY, pickerLine: longDate(DAY) });
    expect(list(open([labRead('f0', { reportDate: null, values: [core({})] })])).days[0]).toMatchObject({ picker: null, pickerLine: '—' });
    const waits = chose(open([labRead('f0', { reportDate: null, values: [core({})] })]), 'f0', { testDay: '2026-12-01' });
    expect(list(waits).days[0]).toMatchObject({ day: null, picker: '2026-12-01', pickerLine: '1 Dec 2026' });
    const partial = chose(open([labRead('f0', { values: [core({ recordedAt: UNDATED_PREVIOUS, printedMonth: '2026-10' })] })]), 'f0', { previousDay: '2026-10' });
    expect(list(partial).days[0]).toMatchObject({ picker: null, pickerLine: DAY_CONTROL_TEXT.noDay });
  });

  it('a letter\'s date button shows its date in words, else "Set the date", as the phone\'s does', () => {
    const s = open([letterRead('d0', 'A'), letterRead('d1', 'B', null)]);
    expect(page(s).letters.map((l) => l.pickerLine)).toEqual(['20 Oct 2026', UPLOAD_TEXT.setDate]);
    expect(page(chose(s, 'd0', { document: { date: null } })).letters[0].pickerLine).toBe('Set the date');
    expect(page(chose(s, 'd1', { document: { date: '2026-09-03' } })).letters[1].pickerLine).toBe('3 Sep 2026');
  });

  it('the words are the grid\'s and the phone\'s, byte for byte', () => {
    expect([DAY_CONTROL_TEXT.noDay, UPLOAD_TEXT.setDate]).toEqual(['—', 'Set the date']);
  });
});
