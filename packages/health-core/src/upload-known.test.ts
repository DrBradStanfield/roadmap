// US-13 AC1, US-12 AC27: what the record already holds, by content (upload
// design section 2). One case per row of the table, then a seeded agreement
// check against the save's own by-hash rule. Synthetic rows and plain fake
// hashes only.
import { describe, expect, it } from 'vitest';
import { LAB_ARCHIVE_TITLE } from './document-path';
import { labArchiveFields, LAB_ARCHIVE_FLAG, LAB_ARCHIVE_ROWS, type DocumentFields } from './document-rows';
import { labArchivePayload, saveDocuments, type DocumentPayload, type DocumentSaveIO } from './document-save';
import { createEmptyFile, createLabValue, type FileDocument, type FileLabValue, type RoadmapFile } from './roadmap-file';
import { withoutListed } from './merge';
import { knownAs, knownIndex, legacyMatch } from './upload-known';

// A record as every reader holds it: rows an erase listed are dropped on read (migrateRecord, mergeFiles).
const record = (documents: FileDocument[], labValues: FileLabValue[] = [], erased: string[] = []): RoadmapFile => withoutListed({
  ...createEmptyFile({ deviceId: 'test', now: '2026-01-01T00:00:00.000Z' }),
  documents, labValues, ...(erased.length ? { erasedRows: { fromEpoch: 0, ids: erased } } : null),
}, new Set(erased));
const doc = (over: Partial<FileDocument> = {}): FileDocument => ({
  id: 'doc-1', title: 'Synthetic letter', type: 'clinic_letter', date: '2026-01-01', fileRef: 'Clinic letters/a.pdf',
  contentHash: 'hash-a', mimeType: 'application/pdf', extractedText: 'Synthetic note', addedAt: '2026-01-01T00:00:00.000Z',
  metadata: {}, sourceFileName: 'a.pdf', ...over,
});
const archive = (over: Partial<FileDocument> = {}): FileDocument => doc({
  id: 'arc-1', title: LAB_ARCHIVE_TITLE, type: 'pathology_report', fileRef: 'Lab results/a.pdf', extractedText: '',
  metadata: { [LAB_ARCHIVE_FLAG]: true }, ...over,
});
const lab = (id: string, over: Partial<FileLabValue> = {}): FileLabValue => ({
  ...createLabValue({ id, metricName: 'synthetic', value: 1, unit: 'u', recordedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', source: 'lab_import' }),
  id, ...over,
});
const listing = (rows: string[], over: Partial<FileDocument> = {}) => archive({ metadata: { [LAB_ARCHIVE_FLAG]: true, [LAB_ARCHIVE_ROWS]: rows }, ...over });
const known = (r: RoadmapFile, hash = 'hash-a') => knownAs(knownIndex(r), hash);

describe('knownIndex / knownAs: one case per row of section 2 (US-13 AC1, US-12 AC27)', () => {
  it('(a) a live document with the hash and a stored original is known, nothing to archive', () => {
    expect(known(record([doc()]))).toEqual({ as: 'document', archiveOnly: false });
  });
  it("(a') a metadata-only document row is known, archive-only", () => {
    expect(known(record([doc({ fileRef: '' })]))).toEqual({ as: 'document', archiveOnly: true });
  });
  it('a stored original wins over a metadata-only row of the same bytes, in either order', () => {
    const held = archive({ id: 'arc-2', fileRef: '' });
    expect(known(record([held, doc()]))).toEqual({ as: 'document', archiveOnly: false });
    expect(known(record([doc(), held]))).toEqual({ as: 'document', archiveOnly: false });
  });
  it('(b) a lab archive row with no row list (legacy) is known', () => {
    expect(known(record([archive()]))).toEqual({ as: 'labReport', archiveOnly: false });
  });
  it('(b) a pre-flag lab archive row, matched by its signature, is known as a lab report', () => {
    expect(known(record([archive({ metadata: {} })]))).toEqual({ as: 'labReport', archiveOnly: false });
  });
  it('(b) a lab archive row is known while one row it produced is active', () => {
    const rows = [lab('lv-1', { status: 'entered-in-error' }), lab('lv-2')];
    expect(known(record([listing(['lv-1', 'lv-2'])], rows)))
      .toEqual({ as: 'labReport', archiveOnly: false });
  });
  it('(b) a row corrected, converted or moved still counts by its newest row', () => {
    const listed = listing(['lv-1']);
    const corrected = [lab('lv-1', { status: 'entered-in-error' }), lab('lv-9', { correctsId: 'lv-1' })];
    expect(known(record([listed], corrected))).not.toBeNull();
    const twice = [corrected[0], lab('lv-9', { status: 'entered-in-error', correctsId: 'lv-1' }), lab('lv-10', { correctsId: 'lv-9' })];
    expect(known(record([listed], twice))).not.toBeNull();
    expect(known(record([listed], [lab('lv-1', { status: 'entered-in-error' }), lab('lv-1#si')]))).not.toBeNull();
  });
  it('(b) a lab archive row whose rows are all entered-in-error, or gone, is not known', () => {
    const listed = listing(['lv-1', 'lv-2']);
    const dead = [lab('lv-1', { status: 'entered-in-error' }), lab('lv-2', { status: 'entered-in-error' })];
    expect(known(record([listed], dead))).toBeNull();
    // Corrected, then the correction deleted: the newest row is not active.
    expect(known(record([listed], [dead[0], lab('lv-9', { status: 'entered-in-error', correctsId: 'lv-1' })]))).toBeNull();
    expect(known(record([listed], []))).toBeNull();
  });
  it("(c) after PR 5: an off-cloud lab report's metadata-only archive row with its rows is known, archive-only", () => {
    const listed = listing(['lv-1'], { fileRef: '' });
    expect(known(record([listed], [lab('lv-1')]))).toEqual({ as: 'labReport', archiveOnly: true });
  });
  it('(d) a hashless row is not known by content', () => {
    const r = record([doc({ contentHash: '', fileRef: '' })]);
    expect(knownIndex(r).size).toBe(0);
    expect(known(r, '')).toBeNull();
  });
  it('a tombstoned document is not known: a re-upload brings it back', () => {
    expect(known(record([doc({ deleted: true })]))).toBeNull();
  });
  it('erased rows are not known: the document listed, or every lab row its archive produced', () => {
    expect(known(record([doc()], [], ['doc-1']))).toBeNull();
    const listed = listing(['lv-1']);
    expect(known(record([listed], [lab('lv-1')], ['lv-1']))).toBeNull();
  });
  it('an empty hash never matches, and another hash is not known', () => {
    expect(known(record([doc(), doc({ id: 'doc-2', contentHash: '' })]), '')).toBeNull();
    expect(known(record([doc()]), 'hash-b')).toBeNull();
  });
});

describe('legacyMatch: hashless older rows, after the read (US-13 AC1, Q5 a)', () => {
  const letter: DocumentFields = {
    documentType: 'clinic_letter', title: 'A new title', documentDate: '2026-01-01', contentMd: 'x', metadata: {}, sourceFileName: 'a.pdf',
  };
  const old = doc({ contentHash: '', fileRef: '' });
  it('matches a live hashless row by name (as dedupFileName reads it), date and type', () => {
    expect(legacyMatch(record([old]), 'a.pdf', letter)).toBe(true);
    expect(legacyMatch(record([old]), 'a (2).pdf', letter)).toBe(true);
  });
  it('a lab report matches only a hashless lab archive row', () => {
    const fields = labArchiveFields('a.pdf', '2026-01-01');
    expect(legacyMatch(record([archive({ contentHash: '', fileRef: '' })]), 'a.pdf', fields)).toBe(true);
    expect(legacyMatch(record([doc({ contentHash: '', type: 'pathology_report' })]), 'a.pdf', fields)).toBe(false);
  });
  it('no match on another name, date or type, a hashed, tombstoned or erased row', () => {
    expect(legacyMatch(record([old]), 'b.pdf', letter)).toBe(false);
    expect(legacyMatch(record([old]), 'a.pdf', { ...letter, documentDate: '2026-01-02' })).toBe(false);
    expect(legacyMatch(record([old]), 'a.pdf', { ...letter, documentType: 'discharge_summary' })).toBe(false);
    expect(legacyMatch(record([doc()]), 'a.pdf', letter)).toBe(false);
    expect(legacyMatch(record([{ ...old, deleted: true }]), 'a.pdf', letter)).toBe(false);
    expect(legacyMatch(record([old], [], ['doc-1']), 'a.pdf', letter)).toBe(false);
  });
});

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HASHES = ['hash-a', 'hash-b', 'hash-c', ''];
const LAB_IDS = ['lv-1', 'lv-2', 'lv-3', 'lv-4'];

function randomRecord(r: () => number): RoadmapFile {
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  const labValues = LAB_IDS.filter(() => r() < 0.7).map((id, i) => lab(r() < 0.2 ? `${id}#si` : id, {
    status: r() < 0.5 ? 'active' : 'entered-in-error', correctsId: i > 0 && r() < 0.3 ? LAB_IDS[i - 1] : null,
  }));
  const documents = Array.from({ length: Math.floor(r() * 6) }, (_, i) => {
    const isLab = r() < 0.4;
    const rows = r() < 0.3 ? undefined : LAB_IDS.filter(() => r() < 0.4);
    const over: Partial<FileDocument> = {
      id: `d-${i}`, contentHash: pick(HASHES), fileRef: r() < 0.5 ? '' : `F/${i}.pdf`, deleted: r() < 0.15,
      title: pick(['Synthetic letter', 'Another title']),
    };
    return isLab ? archive({ ...over, metadata: { [LAB_ARCHIVE_FLAG]: true, ...(rows ? { [LAB_ARCHIVE_ROWS]: rows } : null) } }) : doc(over);
  });
  const erased = [...documents.map((d) => d.id), ...LAB_IDS].filter(() => r() < 0.1);
  return record(documents, labValues, erased);
}

const liveWith = (r: RoadmapFile, hash: string) => r.documents.filter((d) => !d.deleted && d.contentHash === hash);

describe('agreement: whatever knownAs calls known, saveDocuments writes nothing new for (US-13 AC1)', () => {
  it('holds for 400 seeded records and files', async () => {
    const reached = { stored: 0, archiveOnly: 0 };
    for (let seed = 1; seed <= 400; seed++) {
      const r = mulberry32(seed);
      const rec = randomRecord(r);
      const index = knownIndex(rec);
      for (const hash of HASHES) {
        const k = knownAs(index, hash);
        if (!k) continue;
        // The plan files a known file as the kind the record holds it as.
        const payload: DocumentPayload<string> = k.as === 'labReport'
          ? labArchivePayload('a.pdf', '2026-01-01', hash)
          : { documentType: 'clinic_letter', title: 'Synthetic letter', documentDate: '2026-01-01', contentMd: 'x', metadata: {}, sourceFileName: 'a.pdf', file: hash };
        const fail = r() < 0.3;
        const written: string[] = [];
        const io: DocumentSaveIO<string> = {
          hash: async (f) => f, mimeType: () => 'application/pdf', now: () => '2026-02-01T00:00:00.000Z', newId: () => 'new',
          write: async (ref) => { if (fail) throw new Error('synthetic refusal'); written.push(ref); },
        };
        const file = structuredClone(rec);
        const before = liveWith(file, hash).length;
        const plan = await saveDocuments(file, [payload], io);
        plan.commit(file);
        const context = `seed ${seed}, ${hash}, ${JSON.stringify(k)}`;
        expect(liveWith(file, hash).length, context).toBeLessThanOrEqual(before);
        if (k.archiveOnly) {
          reached.archiveOnly++;
          // Filed behind the held row: every new row replaces one.
          expect(plan.saved.every((d) => d.contentHash === hash), context).toBe(true);
        } else {
          reached.stored++;
          expect(plan.saved, context).toEqual([]);
          expect(written, context).toEqual([]);
        }
      }
    }
    expect(reached.stored).toBeGreaterThan(50);
    expect(reached.archiveOnly).toBeGreaterThan(50);
  });
});
