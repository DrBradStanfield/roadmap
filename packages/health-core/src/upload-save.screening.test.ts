/**
 * Design row 12c (US-06 AC5, US-13 AC6, US-12 AC12, US-14 AC10): the web's screening date from a
 * letter, ported into the shared plan and save; a dated previous column's day as a choice; and one
 * `unstored` count for both clients. `isScreeningEligible` is used unchanged, with the web's inputs.
 * Synthetic values, names and hashes only.
 */
import { describe, expect, it } from 'vitest';
import { core, EMPTY, NOW } from './import-review.test-helpers';
import type { UnifiedExtractionResult } from './lab-extraction';
import { choose, NO_CHOICES, type FileChoices } from './upload-choices';
import type { UploadFile, UploadState } from './upload-flow';
import { uploadSavePlan } from './upload-plan';
import { uploadReview, type ScreeningProfile } from './upload-review';
import { uploadSave, type UploadSaveIO } from './upload-save';
import { uploadView } from './upload-view';
import { UPLOAD_STATE } from './upload-schema';

const scanX = (screeningType: string | undefined, documentDate: string | null = '2026-10-20'): UnifiedExtractionResult => ({
  classification: 'scan_result', reportDate: null, values: [], additionalValues: [], unrecognized: [],
  document: { classification: 'scan_result', title: 'Synthetic scan', documentDate, contentMarkdown: 'x', metadata: screeningType ? { screeningType } : {} },
});
const read = (id: string, extraction: UnifiedExtractionResult, choices: FileChoices = NO_CHOICES): UploadFile =>
  ({ id, name: `${id}.pdf`, bytes: 1, hash: `h-${id}`, pages: { count: 1, truncated: false }, status: { s: 'read', extraction, choices } });
const state = (phase: 'open' | 'saving', files: UploadFile[], platform: 'web' | 'phone' = 'web'): UploadState => (phase === 'open'
  ? { phase, platform, run: 1, files, started: NOW, firstRead: NOW }
  : { phase, platform, run: 1, files, started: NOW, firstRead: NOW, attempt: 1 });
const offCloud = (screening?: ScreeningProfile): UploadSaveIO<string> => {
  let n = 0;
  return { holds: () => false, original: () => null, mimeType: () => '', write: async () => {}, now: () => NOW, newId: () => `id-${n++}`, ...(screening ? { screening } : {}) };
};
async function saved(s: UploadState, io: UploadSaveIO<string>, cloudOn = false) {
  const out = await uploadSave(s, EMPTY, NOW, cloudOn, io);
  if (!out.ok) throw new Error(out.reason);
  return out.commit(EMPTY);
}
const plan = (s: UploadState, profile?: ScreeningProfile) => uploadSavePlan(s, EMPTY, NOW, uploadReview(s, EMPTY, NOW, profile), false);

describe('a letter\'s screening date in the shared plan and save (design 12c, US-06 AC5)', () => {
  it('an eligible letter with a known age is ticked by default and Save writes its date', async () => {
    const s = state('saving', [read('scan', scanX('colorectal'))]);
    expect(plan(s, { age: 60, sex: 'male' }).screenings).toEqual([{ fileId: 'scan', type: 'colorectal', key: 'colorectal_last_date', date: expect.stringMatching(/^2026-10-20/), shown: true, ticked: true }]);
    const { file } = await saved(s, offCloud({ age: 60, sex: 'male' }));
    expect(file.screenings.colorectalLastDate).toMatch(/^2026-10-20/);
  });

  it('an ineligible letter is neither shown nor ticked, and Save writes no date', async () => {
    const s = state('saving', [read('scan', scanX('colorectal'))]);
    expect(plan(s, { age: 30, sex: 'male' }).screenings[0]).toMatchObject({ shown: false, ticked: false });
    const { file } = await saved(s, offCloud({ age: 30, sex: 'male' }));
    expect(file.screenings.colorectalLastDate).toBeUndefined();
  });

  it('no age (no plan): shown, unticked; the person\'s tick writes it', async () => {
    const off = state('saving', [read('scan', scanX('colorectal'))]);
    expect(plan(off, {}).screenings[0]).toMatchObject({ shown: true, ticked: false });
    expect((await saved(off, offCloud({}))).file.screenings.colorectalLastDate).toBeUndefined();
    const on = state('saving', [read('scan', scanX('colorectal'), { ...NO_CHOICES, screening: true })]);
    expect((await saved(on, offCloud({}))).file.screenings.colorectalLastDate).toMatch(/^2026-10-20/);
  });

  it('a printed month alone dates the update until a day is picked; a removed date writes none', async () => {
    const month = state('saving', [read('scan', scanX('colorectal', '2026-06'))]);
    expect(plan(month, { age: 60 }).screenings[0]).toMatchObject({ date: '2026-06', ticked: true });
    expect((await saved(month, offCloud({ age: 60 }))).file.screenings.colorectalLastDate).toBe('2026-06');
    const removed = state('saving', [read('scan', scanX('colorectal'), { ...NO_CHOICES, document: { date: null } })]);
    expect(plan(removed, { age: 60 }).screenings[0]).toMatchObject({ date: null });
    expect((await saved(removed, offCloud({ age: 60 }))).file.screenings.colorectalLastDate).toBeUndefined();
  });

  it('the person\'s untick wins over the default', async () => {
    const s = state('saving', [read('scan', scanX('colorectal'), { ...NO_CHOICES, screening: false })]);
    expect((await saved(s, offCloud({ age: 60 }))).file.screenings.colorectalLastDate).toBeUndefined();
  });

  it('the iPhone (no profile) offers and writes none: its behaviour is unchanged', async () => {
    const s = state('saving', [read('scan', scanX('colorectal'))], 'phone');
    expect(plan(s).screenings).toEqual([]);
    expect((await saved(s, offCloud())).file.screenings.colorectalLastDate).toBeUndefined();
    const open = state('open', [read('scan', scanX('colorectal'))], 'phone');
    expect(uploadView(open, EMPTY, NOW, uploadReview(open, EMPTY, NOW), false).documents?.rows[0].screening).toBeNull();
  });

  it('the view draws the row in the web\'s words, its tick disabled while there is no date', () => {
    const open = state('open', [read('scan', scanX('colorectal'))]);
    const row = uploadView(open, EMPTY, NOW, uploadReview(open, EMPTY, NOW, { age: 60 }), false).documents?.rows[0].screening;
    expect(row).toEqual({ checked: true, enabled: true, words: ['Update ', 'colorectal', expect.stringMatching(/^ screening date to 2026-10-20/)] });
    const none = state('open', [read('scan', scanX('colorectal', null))]);
    expect(uploadView(none, EMPTY, NOW, uploadReview(none, EMPTY, NOW, { age: 60 }), false).documents?.rows[0].screening)
      .toEqual({ checked: false, enabled: false, words: ['Update ', 'colorectal', ' screening date (pick the document date first)'] });
  });
});

describe('choices the web needs, through `choose` (US-12 AC12)', () => {
  const prev = (day: string): UnifiedExtractionResult => ({ classification: 'lab_report', reportDate: '2026-10-01', values: [core({ recordedAt: day })], additionalValues: [], unrecognized: [], document: null });

  it('a dated previous column\'s day moves its values; a day not yet happened is refused', () => {
    const x = prev('2026-05-01');
    const picked = choose(NO_CHOICES, { columnDay: '2026-05-01', day: '2026-05-02' }, NOW, x);
    expect(picked?.columnDays).toEqual({ '2026-05-01': expect.stringMatching(/^2026-05-02/) });
    expect(choose(NO_CHOICES, { columnDay: '2026-05-01', day: '2999-01-01' }, NOW, x)).toBeNull();
    const s = state('open', [read('lab', x, picked!)]);
    expect(uploadReview(s, EMPTY, NOW).classification.rows.map((r) => r.recordedAt.slice(0, 10))).toEqual(['2026-05-02']);
    expect(choose(picked!, { columnDay: '2026-05-01', day: null }, NOW, x)?.columnDays).toEqual({});
  });

  it('a moved column clears the Replace on its values (US-13 AC7)', () => {
    const x = prev('2026-05-01');
    const c = choose(NO_CHOICES, { replace: 'v0', correctsId: 'held' }, NOW, x)!;
    expect(choose(c, { columnDay: '2026-05-01', day: '2026-05-03' }, NOW, x)?.replace).toEqual({});
  });

  it('a screening tick is a choice like any other', () => {
    expect(choose(NO_CHOICES, { screening: false }, NOW, scanX('colorectal'))?.screening).toBe(false);
  });

  it('the new choices pass the door\'s schema; an old phone\'s choices still do', () => {
    const withChoices = (choices: object) => UPLOAD_STATE.safeParse(state('open', [read('scan', scanX('colorectal'), choices as FileChoices)])).success;
    expect(withChoices({ ...NO_CHOICES, screening: true, columnDays: { '2026-05-01': '2026-05-02' } })).toBe(true);
    expect(withChoices(NO_CHOICES)).toBe(true);
  });
});

describe('one unstored count for both clients (design 12c)', () => {
  it('a cloud write that fails with no held row is counted unstored, and its row keeps the hash', async () => {
    const lab: UnifiedExtractionResult = { classification: 'lab_report', reportDate: '2026-10-01', values: [core()], additionalValues: [], unrecognized: [], document: null };
    const io: UploadSaveIO<string> = { holds: () => true, original: (id) => `bytes ${id}`, mimeType: () => 'application/pdf', write: async () => { throw new Error('refused'); }, now: () => NOW, newId: () => 'id' };
    const { file, outcome } = await saved(state('saving', [read('lab', lab)]), io, true);
    expect(outcome.unstored).toBe(1);
    expect(file.documents.map((d) => [d.contentHash, d.fileRef])).toEqual([['h-lab', '']]);
  });
});
