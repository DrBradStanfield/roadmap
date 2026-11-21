/**
 * The owner's rulings on PR 1840's review, one block per item (US-52 AC8c, US-13 AC13, AC14,
 * US-12 AC9, AC14, US-14 AC4): default ticks per platform, Save waits for every report's day,
 * Replace and edits, the cloud and originals, readable held rows, document dates, a failed save,
 * two files with one hash, read files with nothing in them, proposed words. Synthetic values.
 */
import { describe, expect, it } from 'vitest';
import { core, DAY, EMPTY, extra, NOW, recordWith } from './import-review.test-helpers';
import type { UnifiedExtractionResult } from './lab-extraction';
import { documentRow } from './document-rows';
import { importRow } from './import-review';
import type { RoadmapFile } from './roadmap-file';
import { NO_CHOICES, type FileChoices } from './upload-choices';
import { transition, type UploadFile, type UploadState } from './upload-flow';
import { uploadSavePlan } from './upload-plan';
import { uploadReview } from './upload-review';
import { uploadView } from './upload-view';

const labX = (over: Partial<UnifiedExtractionResult> = {}): UnifiedExtractionResult =>
  ({ classification: 'lab_report', reportDate: DAY, values: [core()], additionalValues: [], unrecognized: [], document: null, ...over });
const letterX = (date: string | null = '2026-10-20'): UnifiedExtractionResult => ({
  classification: 'clinic_letter', reportDate: null, values: [], additionalValues: [], unrecognized: [],
  document: { classification: 'clinic_letter', title: 'Letter', documentDate: date, contentMarkdown: 'text', metadata: {} },
});
const read = (id: string, extraction: UnifiedExtractionResult, choices: Partial<FileChoices> = {}, hash = `h-${id}`): UploadFile =>
  ({ id, name: `${id}.pdf`, bytes: 1, hash, pages: { count: 1, truncated: false }, status: { s: 'read', extraction, choices: { ...NO_CHOICES, ...choices } } });
const open = (files: UploadFile[], platform: 'web' | 'phone' = 'web'): UploadState => ({ phase: 'open', platform, run: 1, files, started: NOW, firstRead: null });
const both = (s: UploadState, record: RoadmapFile = EMPTY, cloud = true) => {
  const review = uploadReview(s, record, NOW);
  return { plan: uploadSavePlan(s, record, NOW, review, cloud), view: uploadView(s, record, NOW, review, cloud) };
};
const asked = labX({ values: [core(), core({ metric: 'hdl', valueSI: 1.2, displayValue: 1.2, question: 'Was this a blood test?' })] });

describe('1. a value the extractor asked about: saved unless cleared, on both clients (Brad 2026-11-20)', () => {
  it('the web and the iPhone both save it unless cleared; clearing it leaves it out; the row says which', () => {
    const web = both(open([read('a', asked)], 'web'));
    const phone = both(open([read('a', asked)], 'phone'));
    expect([web.plan.counts.values, phone.plan.counts.values]).toEqual([2, 2]);
    const row = (v: typeof web.view) => v.sections.flatMap((x) => (x.kind === 'unsure' ? x.rows : [])).find((r) => r.ref === 'v1');
    expect([row(web.view)?.ticked, row(phone.view)?.ticked]).toEqual([true, true]);
    expect(both(open([read('a', asked, { ticks: { v1: false } })], 'phone')).plan.counts.values).toBe(1);
  });
});

describe('2. Save waits for every report that needs a day', () => {
  it('one dated report and one undated: Save is off with the why line, and the dated one is not saved alone', () => {
    const { view, plan } = both(open([read('a', labX()), read('u', labX({ reportDate: null }))]));
    expect(view.save).toEqual({ label: 'Save 1 value', enabled: false, why: 'Choose the day of the test', error: null, blockers: [{ why: 'Choose the day of the test', at: 'u|test' }] });
    expect(plan.labRows.map((l) => l.fileId)).toEqual(['a']);
  });
});

describe('3. Replace and an edited value, as the web\'s review builds them', () => {
  const record = recordWith([{ kind: 'measurement', metricType: 'ldl', value: 2.0 }]);
  it('a conflict names its held row; Replace writes the value as its correction', () => {
    const before = both(open([read('a', labX())]), record);
    const conflict = before.view.sections.flatMap((x) => (x.kind === 'unsure' ? x.rows : []))[0];
    expect(conflict).toMatchObject({ ref: 'v0', conflict: expect.any(String), replaces: record.measurements[0]?.id ?? record.labValues[0].id });
    expect(before.plan.counts.values).toBe(0);
    const after = both(open([read('a', labX(), { replace: { v0: conflict.replaces! } })]), record);
    expect(after.plan.labRows[0].rows).toEqual([importRow(labX(), 'v0', DAY, { correctsId: conflict.replaces! })]);
  });

  it('an edited value saves as the web saves it (lab_import_edited, its number); an out-of-range edit is named, never dropped', () => {
    const edited = both(open([read('a', labX({ additionalValues: [extra()] }), { edits: { a0: 95 } })]));
    expect(edited.plan.labRows[0].rows).toContainEqual(importRow(labX({ additionalValues: [extra()] }), 'a0', DAY, { edited: { value: 95 } }));
    expect(edited.plan.labRows[0].rows.find((r) => r.kind === 'lab')).toMatchObject({ value: 95, source: 'lab_import_edited' });
    const wild = both(open([read('a', labX(), { edits: { v0: 999 } })]));
    expect(wild.plan.counts.values).toBe(0);
    expect(wild.view.sections.flatMap((x) => (x.kind === 'unsure' ? x.rows : []))).toContainEqual(expect.objectContaining({ ref: 'v0', reasons: expect.arrayContaining(['outOfRange']) }));
  });
});

describe('4. originals need a cloud', () => {
  const held = documentRow({ documentType: 'clinic_letter', title: 'Held', documentDate: null, contentMd: 't', metadata: {}, sourceFileName: 'x.pdf' }, { id: 'd1', contentHash: 'h-k', mimeType: '', addedAt: NOW });
  const known: UploadFile = { id: 'k', name: 'k.pdf', bytes: 1, hash: 'h-k', pages: null, status: { s: 'known', as: 'document', archiveOnly: true } };
  it('with a cloud a known archive-only file is filed and counted; without one it is neither, and never enables Save', () => {
    const record = { ...EMPTY, documents: [held] };
    expect(both(open([known]), record, true).view.save).toMatchObject({ label: 'Save 1 original', enabled: true });
    const off = both(open([known]), record, false);
    expect(off.plan.archiveOnly).toEqual([]);
    expect(off.view.save).toMatchObject({ enabled: false, why: 'Nothing new to save' });
  });
  it('a report whose values the record holds files its original only with a cloud; every value unticked, only with a cloud (US-14 AC11)', () => {
    const record = recordWith([{ kind: 'measurement', metricType: 'ldl', value: 3.1 }]);
    expect(both(open([read('a', labX())]), record, true).view.save).toMatchObject({ label: 'Save 1 original', enabled: true });
    expect(both(open([read('a', labX())]), record, false).view.save).toMatchObject({ enabled: false });
    expect(both(open([read('a', labX(), { ticks: { v0: false } })]), EMPTY, false).plan.labArchives).toEqual([]);
    expect(both(open([read('a', labX(), { ticks: { v0: false } })])).plan.labArchives).toEqual([{ fileId: 'a', sourceFileName: 'a.pdf', reportDate: DAY }]);
  });
});

describe('5. archive-only fields come only from a readable held row', () => {
  it('an unreadable newer row sharing the hash is passed over for the readable one', () => {
    const readable = documentRow({ documentType: 'clinic_letter', title: 'Readable', documentDate: null, contentMd: 't', metadata: {}, sourceFileName: 'x.pdf' }, { id: 'r', contentHash: 'h-k', mimeType: '', addedAt: '2026-01-01T00:00:00.000Z' });
    const unreadable = { ...documentRow({ documentType: 'clinic_letter', title: 'x', documentDate: null, contentMd: 't', metadata: {}, sourceFileName: 'y.pdf' }, { id: 'u', contentHash: 'h-k', mimeType: '', addedAt: '2026-06-01T00:00:00.000Z' }), title: 123 as never };
    const record = { ...EMPTY, documents: [readable, unreadable] };
    const known: UploadFile = { id: 'k', name: 'k.pdf', bytes: 1, hash: 'h-k', pages: null, status: { s: 'known', as: 'document', archiveOnly: true } };
    expect(both(open([known]), record).plan.archiveOnly[0].fields.title).toBe('Readable');
  });
});

describe('6. a document date is a real day that has happened', () => {
  it('a future or impossible date is refused at chose; null removes the date', () => {
    const s = open([read('l', letterX())]);
    for (const date of ['2027-01-01', '2026-02-30']) {
      expect(transition(s, { type: 'chose', id: 'l', change: { document: { date } }, now: NOW }).state).toBe(s);
    }
    const removed = transition(s, { type: 'chose', id: 'l', change: { document: { date: null } }, now: NOW }).state;
    expect(both(removed).plan.documents[0].fields.documentDate).toBeNull();
  });
  it('the plan guards it too: a date that slipped in is never planned', () => {
    const plan = both(open([read('l', letterX('2026-10-20'), { document: { date: '2027-01-01' } })])).plan;
    expect(plan.documents[0].fields.documentDate).toBe('2026-10-20');
  });
});

describe('7. a failed save is retried from the view', () => {
  it('saving shows Save off; saveFailed shows the message and Save on; retry reaches done with the choices intact', () => {
    let s = open([read('a', labX(), { ticks: { v0: true } })]);
    s = transition(s, { type: 'saveStarted' }).state;
    expect(both(s).view.save).toMatchObject({ enabled: false, error: null });
    s = transition(s, { type: 'saveFailed', run: 1, attempt: 1, message: 'Your cloud did not answer.' }).state;
    expect(both(s).view.save).toMatchObject({ enabled: true, error: 'Your cloud did not answer.' });
    expect('files' in s && s.files[0].status).toMatchObject({ choices: { ticks: { v0: true } } });
    const retry = transition(s, { type: 'saveStarted' });
    expect(retry.effects).toEqual([{ type: 'save', run: 1, attempt: 2 }]);
    expect(transition(retry.state, { type: 'saved', run: 1, attempt: 2, outcome: { values: 1, documents: 0, archived: 0 } }).state.phase).toBe('done');
  });
});

describe('8. two read files with the same bytes', () => {
  it('the document is planned once, the first picked; the second keeps its plain status', () => {
    for (const cloud of [true, false]) {
      const { plan, view } = both(open([read('l1', letterX(), {}, 'same'), read('l2', letterX(), {}, 'same')]), EMPTY, cloud);
      expect(plan.documents.map((d) => d.fileId)).toEqual(['l1']);
      expect(view.documents?.line).toBe('1 letter or document will be saved');
      expect(view.files.rows.map((r) => r.status)).toEqual(['Read', 'Read']);
    }
  });
});

describe('9. a read file with nothing in it is said', () => {
  it('a lab report with no values, and a file with no document, in the web\'s words', () => {
    const view = both(open([read('e', labX({ values: [] })), read('n', { ...letterX(), document: null })])).view;
    expect(view.notices).toEqual([
      { fileId: 'e', name: 'e.pdf', line: 'No blood test values found.' },
      { fileId: 'n', name: 'n.pdf', line: 'No blood test values found.' },
    ]);
  });

  // What each screen draws of the view (US-12 AC9): the web's review its Files block, the rows and the notices
  // (UploadListParts.tsx `Files`); the web's done screen the notices alone (UploadList.tsx `Done`); the iPhone's review the
  // notices and, collapsed, the rows (UploadReviewView.swift); its done screen the rows alone. Each reason once on each.
  const DRAWN = {
    web: { review: ['files', 'notices'], done: ['notices'] },
    phone: { review: ['files', 'notices'], done: ['files'] },
  } as const;
  const reasons = ['No blood test values found.', 'Filed as a document. No blood test values found.'];
  for (const platform of ['web', 'phone'] as const) {
    for (const screen of ['review', 'done'] as const) {
      it(`says it exactly once on the ${platform} ${screen} screen`, () => {
        const picked = open([read('e', labX({ values: [] })), read('d', labX({ values: [], document: letterX().document }))], platform);
        const s: UploadState = screen === 'review' ? picked : { ...picked, phase: 'done', outcome: { values: 0, documents: 1, archived: 0 } } as UploadState;
        const view = both(s).view;
        const drawn = DRAWN[platform][screen].flatMap((key) => (key === 'files' ? view.files.rows.map((r) => r.status) : view.notices.map((n) => n.line)));
        for (const line of reasons) expect(drawn.filter((l) => l === line)).toHaveLength(1);
      });
    }
  }
});

describe('11. cost', () => {
  it('200 read reports of 10 values: one review and one view well inside a generous bound', () => {
    const many = Array.from({ length: 200 }, (_, i) => read(`f${i}`, labX({
      reportDate: `2026-0${1 + (i % 9)}-${10 + (i % 18)}`,
      values: [core(), core({ metric: 'hdl', valueSI: 1.2 }), core({ metric: 'triglycerides', valueSI: 1.5 }), core({ metric: 'hba1c', valueSI: 39 }), core({ metric: 'creatinine', valueSI: 80 })],
      additionalValues: [extra(), extra({ name: 'Vitamin B12', value: 400, unit: 'pmol/L' }), extra({ name: 'Folate', value: 20, unit: 'nmol/L' }), extra({ name: 'TSH', value: 2, unit: 'mIU/L' }), extra({ name: 'Sodium', value: 140, unit: 'mmol/L' })],
    })));
    const start = performance.now();
    both(open(many));
    expect(performance.now() - start).toBeLessThan(2000);
  });
});
