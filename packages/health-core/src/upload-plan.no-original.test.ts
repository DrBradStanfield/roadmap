/**
 * A photo or a scan carries no original (US-52 AC13e, owner ruling D1 2026-11-20): the iPhone's
 * consent screen says only a report picked from Files is kept in the cloud. Such a file is picked
 * with `original: false`, and the plan stores, counts and archives no original for it: no lab
 * archive row, no archive-only original. A letter read from it is still saved as a document (its
 * text is the content). Synthetic values, names and hashes only.
 */
import { describe, expect, it } from 'vitest';
import { core, DAY, EMPTY, NOW, recordWith } from './import-review.test-helpers';
import type { UnifiedExtractionResult } from './lab-extraction';
import type { RoadmapFile } from './roadmap-file';
import type { FileChoices } from './upload-choices';
import { transition, type UploadFile, type UploadState } from './upload-flow';
import { planIsEmpty, uploadSavePlan } from './upload-plan';
import { uploadReview } from './upload-review';
import { uploadSave, type UploadSaveIO } from './upload-save';
import { UPLOAD_EVENT, UPLOAD_STATE } from './upload-schema';
import { uploadView } from './upload-view';

const NO: FileChoices = { ticks: {}, testDay: null, previousDay: null, replace: {}, edits: {}, document: {} };
const labX: UnifiedExtractionResult = { classification: 'lab_report', reportDate: DAY, values: [core()], additionalValues: [], unrecognized: [], document: null };
const letterX: UnifiedExtractionResult = {
  classification: 'clinic_letter', reportDate: null, values: [], additionalValues: [], unrecognized: [],
  document: { classification: 'clinic_letter', title: 'Synthetic letter', documentDate: '2026-10-20', contentMarkdown: '## Plan', metadata: {} },
};
const read = (id: string, extraction: UnifiedExtractionResult, original?: false): UploadFile => ({
  id, name: `${id}.jpg`, bytes: 1, hash: `h-${id}`, pages: { count: 1, truncated: false }, status: { s: 'read', extraction, choices: NO },
  ...(original === false ? { original } : {}),
});
const open = (files: UploadFile[]): UploadState => ({ phase: 'open', platform: 'phone', run: 1, files, started: NOW, firstRead: NOW });
const plan = (s: UploadState, record: RoadmapFile = EMPTY) => uploadSavePlan(s, record, NOW, uploadReview(s, record, NOW), true);
const view = (s: UploadState, record: RoadmapFile = EMPTY) => uploadView(s, record, NOW, uploadReview(s, record, NOW), true);
const cloud = (): UploadSaveIO<string> & { stored: string[] } => {
  const stored: string[] = [];
  let n = 0;
  return { stored, holds: () => true, original: (id) => `bytes of ${id}`, mimeType: () => 'image/jpeg', write: async (ref) => void stored.push(ref), now: () => NOW, newId: () => `id-${n++}` };
};

describe('a pick with no original (US-52 AC13e, owner ruling D1)', () => {
  it('a photographed lab report plans its values and no archive, counts no original', () => {
    const p = plan(open([read('photo', labX, false)]));
    expect(p.labRows).toHaveLength(1);
    expect(p.labArchives).toEqual([]);
    expect(p.counts.originals).toBe(0);
  });

  it('control: a lab report picked from Files still archives its original', () => {
    const p = plan(open([read('file', labX)]));
    expect(p.labArchives.map((a) => a.fileId)).toEqual(['file']);
    expect(p.counts.originals).toBe(1);
  });

  it('with its values already held: Nothing new to save, never "Save 1 original"', () => {
    const held = recordWith([{ kind: 'measurement', metricType: 'ldl', value: 3.1 }]);
    const v = view(open([read('photo', labX, false)]), held);
    expect(v.save.why).toBe('Nothing new to save');
    expect(v.save.label).not.toMatch(/original/);
    expect(planIsEmpty(plan(open([read('photo', labX, false)]), held))).toBe(true);
  });

  it('a Save of a photographed lab report writes its values and no hidden archive row, stores nothing', async () => {
    const s: UploadState = { ...open([read('photo', labX, false)]), phase: 'saving', attempt: 1 } as UploadState;
    const io = cloud();
    const out = await uploadSave(s, EMPTY, NOW, true, io);
    if (!out.ok) throw new Error(out.reason);
    const { file, outcome } = out.commit(EMPTY);
    expect(outcome).toEqual({ values: 1, documents: 0, archived: 0, unstored: 0 });
    expect(file.documents).toEqual([]);
    expect(io.stored).toEqual([]);
  });

  it('a letter from a photo is still saved as a document', () => {
    const p = plan(open([read('photo', letterX, false)]));
    expect(p.documents.map((d) => d.fileId)).toEqual(['photo']);
  });

  it('a letter from a photo saves as a document with no original stored, even when the platform holds its bytes', async () => {
    const s: UploadState = { ...open([read('photo', letterX, false)]), phase: 'saving', attempt: 1 } as UploadState;
    const io = cloud();
    const out = await uploadSave(s, EMPTY, NOW, true, io);
    if (!out.ok) throw new Error(out.reason);
    const { file, outcome } = out.commit(EMPTY);
    expect(outcome).toEqual({ values: 0, documents: 1, archived: 0, unstored: 0 });
    expect(file.documents.map((d) => [d.title, d.fileRef, d.contentHash])).toEqual([['Synthetic letter', '', 'h-photo']]);
    expect(io.stored).toEqual([]);
  });

  it('a known photo files no archive-only original', () => {
    const known: UploadFile = { id: 'kn', name: 'kn.jpg', bytes: 1, hash: 'h-kn', pages: null, status: { s: 'known', as: 'document', archiveOnly: true }, original: false };
    const record: RoadmapFile = { ...EMPTY, documents: [{ id: 'held', title: 'Held', type: 'clinic_letter', date: '2026-01-01', fileRef: '', contentHash: 'h-kn', mimeType: '', extractedText: '', addedAt: NOW, metadata: {}, sourceFileName: 'kn.jpg' }] };
    const p = plan(open([known]), record);
    expect(p.archiveOnly).toEqual([]);
    expect(p.counts.originals).toBe(0);
  });

  it('the picked event carries it, the strict schema takes it, and the state keeps it on the file', () => {
    const event = { type: 'picked', needsConsent: false, now: NOW, files: [{ id: 'p', name: 'Photo.jpg', bytes: 10, kind: 'file', original: false }] };
    expect(UPLOAD_EVENT.safeParse(event).success).toBe(true);
    expect(UPLOAD_EVENT.safeParse({ ...event, files: [{ ...event.files[0], original: true }] }).success).toBe(false);
    const next = transition({ phase: 'choosing', platform: 'phone', run: 0 }, UPLOAD_EVENT.parse(event)).state;
    expect('files' in next && next.files[0].original).toBe(false);
    expect(UPLOAD_STATE.safeParse(next).success).toBe(true);
    // A file picked without it carries none.
    const plain = transition({ phase: 'choosing', platform: 'phone', run: 0 }, UPLOAD_EVENT.parse({ ...event, files: [{ id: 'f', name: 'a.pdf', bytes: 10, kind: 'file' }] })).state;
    expect('files' in plain && 'original' in plain.files[0]).toBe(false);
  });
});
