/**
 * upload-view.ts and upload-plan.ts as a caller sees them, one case per screen state of the
 * design's section 4 (US-52 AC8c, US-13 AC13, AC14, US-12 AC26 to AC28): reading, mixed, all
 * known, failed with Try again, an undated report, nothing new to save, done. Synthetic values.
 */
import { describe, expect, it } from 'vitest';
import { core, DAY, EMPTY, extra, NOW, recordWith } from './import-review.test-helpers';
import type { UnifiedExtractionResult } from './lab-extraction';
import { documentRow } from './document-rows';
import type { FileChoices, FileStatus, UploadFile, UploadState } from './upload-flow';
import { uploadSavePlan } from './upload-plan';
import { uploadView } from './upload-view';

const CHOICES: FileChoices = { ticks: {}, testDay: null, document: {} };
const labX = (over: Partial<UnifiedExtractionResult> = {}): UnifiedExtractionResult =>
  ({ classification: 'lab_report', reportDate: DAY, values: [core()], additionalValues: [], unrecognized: [], document: null, ...over });
const letterX = (over: Partial<NonNullable<UnifiedExtractionResult['document']>> = {}): UnifiedExtractionResult => ({
  classification: 'clinic_letter', reportDate: null, values: [], additionalValues: [], unrecognized: [],
  document: { classification: 'clinic_letter', title: 'Cardiology letter', documentDate: '2026-10-20', contentMarkdown: '## Plan', metadata: {}, ...over },
});
const read = (id: string, extraction: UnifiedExtractionResult, choices = CHOICES): UploadFile =>
  ({ id, name: `${id}.pdf`, bytes: 1, hash: `h-${id}`, pages: { count: 1, truncated: false }, status: { s: 'read', extraction, choices } });
const at = (id: string, status: FileStatus, hash: string | null = `h-${id}`): UploadFile => ({ id, name: `${id}.pdf`, bytes: 1, hash, pages: null, status });
const open = (files: UploadFile[]): UploadState => ({ phase: 'open', platform: 'web', run: 1, files, started: NOW, firstRead: null });

describe('upload view: section 4 screens', () => {
  it('reading: progress, a ZIP line, Stop, Save waits and says for how many files', () => {
    const s = open([read('a', labX()), { ...at('m1', { s: 'sending', attempt: 1 }), zip: 'health.zip' }, { ...at('m2', { s: 'waiting' }, null), zip: 'health.zip' }, at('b', { s: 'converting' })]);
    const v = uploadView(s, EMPTY, NOW);
    expect(v.progress).toEqual({ done: 1, total: 4, line: 'Reading 1 of 4 files', zip: 'health.zip: 0 of 2 inside' });
    expect(v.stop).toEqual({ label: 'Stop' });
    expect(v.save).toEqual({ label: 'Save 1 value', enabled: false, why: 'Wait for 3 files to finish' });
    expect(v.files.rows.map((r) => r.status)).toEqual(['Read', 'Reading', 'Waiting', 'Reading']);
    expect(v.files.row).toBe('Files (4)');
  });

  it('mixed: summary of known, letters and lab reports; check, sure and documents; Save counts what the plan writes', () => {
    const s = open([
      at('k', { s: 'known', as: 'document', archiveOnly: false }),
      read('lab', labX({ values: [core(), core({ metric: 'hdl', valueSI: 1.2, displayValue: 1.2, confidence: 'low' })], additionalValues: [extra()] })),
      read('letter', letterX()),
    ]);
    const v = uploadView(s, EMPTY, NOW);
    const plan = uploadSavePlan(s, EMPTY, NOW);
    expect(v.summary).toBe('3 files: 1 already in your record, 1 clinic letter, 1 lab report');
    expect(v.progress).toBeNull();
    expect(v.stop).toBeNull();
    expect(v.sections.map((x) => x.kind)).toEqual(['unsure']);
    expect(v.sections[0]).toMatchObject({ title: 'Check this value', rows: [{ fileId: 'lab', ref: 'v1', reasons: ['confidence'] }] });
    expect(v.sure).toMatchObject({ line: '2 values will be saved', showAll: 'Show all 2' });
    expect(v.documents).toEqual({ line: '1 letter or document will be saved', rows: [{ fileId: 'letter', title: 'Cardiology letter', kind: 'clinic letter', date: '2026-10-20', dateKnown: true }] });
    expect(plan.counts).toEqual({ values: 3, documents: 1, archived: 0 });
    expect(v.save).toEqual({ label: 'Save 3 values and 1 document', enabled: true, why: null });
    expect(v.files.rows[0].status).toBe('Already in your record');
    // The known file is counted, never a row: no value, document or section names it.
    expect(JSON.stringify([v.sections, v.sure, v.documents])).not.toContain('"k"');
  });

  it('all known: its own line; Save has nothing new', () => {
    const v = uploadView(open([at('a', { s: 'known', as: 'labReport', archiveOnly: false }), at('b', { s: 'known', as: 'document', archiveOnly: false })]), EMPTY, NOW);
    expect(v.summary).toBe('Everything here is already in your record.');
    expect(v.save).toMatchObject({ enabled: false, why: 'Nothing new to save' });
  });

  it('failed: one section naming each file in the web\'s words, Try again only when a retry can help; Save not blocked', () => {
    const s = open([
      read('a', labX()),
      at('busy', { s: 'failed', reason: 'busy', attempt: 1 }),
      at('limit', { s: 'failed', reason: 'dailyLimit', attempt: 1 }),
      at('z', { s: 'failed', reason: 'zipEmpty', attempt: 0 }, null),
    ]);
    const v = uploadView(s, EMPTY, NOW);
    expect(v.sections).toEqual([{
      kind: 'failed', title: '3 files not read', retry: 'Try again',
      rows: [
        { fileId: 'busy', name: 'busy.pdf', line: 'Not read. Our server was busy. Please try again later.' },
        { fileId: 'limit', name: 'limit.pdf', line: 'Not read. The daily upload limit was reached.' },
        { fileId: 'z', name: 'z.pdf', line: 'No files we can read inside this ZIP.' },
      ],
    }]);
    expect(v.save).toEqual({ label: 'Save 1 value', enabled: true, why: null });
    const final = uploadView(open([read('a', labX()), at('limit', { s: 'failed', reason: 'dailyLimit', attempt: 1 })]), EMPTY, NOW);
    expect(final.sections[0]).toMatchObject({ title: '1 file not read', retry: null });
  });

  it('undated report: one section per report with no full day; its values wait until a day is picked', () => {
    const undated = labX({ reportDate: null });
    const v = uploadView(open([read('u', undated)]), EMPTY, NOW);
    expect(v.sections[0]).toEqual({ kind: 'undated', fileId: 'u', title: 'This report has no date', name: 'u.pdf' });
    expect(v.save).toMatchObject({ enabled: false, why: 'Nothing new to save' });
    expect(uploadSavePlan(open([read('u', undated)]), EMPTY, NOW).labArchives).toEqual([]); // the original waits with its values
    const picked = uploadView(open([read('u', undated, { ...CHOICES, testDay: DAY })]), EMPTY, NOW);
    expect(picked.sections.map((x) => x.kind)).toEqual([]);
    expect(picked.save).toEqual({ label: 'Save 1 value', enabled: true, why: null });
  });

  it('nothing new to save: every value already in the record, the report\'s original still filed', () => {
    const record = recordWith([{ kind: 'measurement', metricType: 'ldl', value: 3.1 }]);
    const s = open([read('a', labX())]);
    const plan = uploadSavePlan(s, record, NOW);
    expect(plan.counts.values).toBe(0);
    expect(plan.labArchives).toEqual([{ fileId: 'a', sourceFileName: 'a.pdf', reportDate: DAY }]);
    // The original alone: a label section 5 does not have yet (UPLOAD_TEXT_PROPOSED).
    expect(uploadView(s, record, NOW).save).toEqual({ label: 'Save 1 original', enabled: true, why: null });
    const letterKnown = open([at('k', { s: 'known', as: 'document', archiveOnly: false })]);
    expect(uploadView(letterKnown, record, NOW).save).toEqual({ label: 'Save 0 values', enabled: false, why: 'Nothing new to save' });
  });

  it('done: one line, each part dropped at zero, and the originals kept', () => {
    const done = (values: number, documents: number, archived: number): UploadState =>
      ({ phase: 'done', platform: 'web', run: 1, files: [], started: NOW, firstRead: null, outcome: { values, documents, archived } });
    expect(uploadView(done(42, 8, 0), EMPTY, NOW).done).toEqual({ line: 'Saved 42 values and 8 documents.', archived: null });
    expect(uploadView(done(0, 1, 2), EMPTY, NOW).done).toEqual({ line: 'Saved 1 document.', archived: '2 original files kept in your cloud.' });
    expect(uploadView(done(1, 0, 1), EMPTY, NOW).done).toEqual({ line: 'Saved 1 value.', archived: '1 original file kept in your cloud.' });
  });
});

describe('upload plan: documents and originals', () => {
  it('a letter is saved by default with the person\'s fixes; a held metadata-only row gives the starting title and date', () => {
    const held = documentRow({ documentType: 'clinic_letter', title: 'Held title', documentDate: '2026-09-01', contentMd: '', metadata: {}, sourceFileName: 'old.pdf' },
      { id: 'd1', contentHash: 'h-l', mimeType: '', addedAt: NOW });
    const record = { ...EMPTY, documents: [held] };
    const plain = uploadSavePlan(open([read('l', letterX())]), record, NOW);
    expect(plain.documents[0].fields).toMatchObject({ title: 'Held title', documentDate: '2026-09-01', documentType: 'clinic_letter', contentMd: '## Plan', sourceFileName: 'l.pdf' });
    const fixed = uploadSavePlan(open([read('l', letterX(), { ...CHOICES, document: { title: 'Mine', kind: 'discharge_summary', date: null } })]), record, NOW);
    expect(fixed.documents[0].fields).toMatchObject({ title: 'Mine', documentType: 'discharge_summary', documentDate: null });
  });

  it('a known archive-only file is filed behind the row the record holds, as that row\'s kind; a legacy match is never saved', () => {
    const letter = documentRow({ documentType: 'clinic_letter', title: 'Held', documentDate: null, contentMd: 'text', metadata: {}, sourceFileName: 'x.pdf' },
      { id: 'd1', contentHash: 'h-k', mimeType: '', addedAt: NOW });
    const record = { ...EMPTY, documents: [letter] };
    const plan = uploadSavePlan(open([at('k', { s: 'known', as: 'document', archiveOnly: true }), at('g', { s: 'known', as: 'legacy', archiveOnly: false })]), record, NOW);
    expect(plan.archiveOnly).toEqual([{ fileId: 'k', fields: { documentType: 'clinic_letter', title: 'Held', documentDate: null, contentMd: 'text', metadata: {}, sourceFileName: 'k.pdf' } }]);
    expect(plan.counts).toEqual({ values: 0, documents: 0, archived: 1 });
    expect(uploadView(open([at('k', { s: 'known', as: 'document', archiveOnly: true })]), record, NOW).save).toEqual({ label: 'Save 1 original', enabled: true, why: null });
  });
});
