// US-13 AC1, US-14 AC4, US-35 AC6/AC8: health-core's one document-save rule,
// shared by the website and the iPhone app. Bytes are Uint8Array here, as on
// the phone. Synthetic bytes only.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createEmptyFile, type FileDocument, type RoadmapFile } from './roadmap-file';
import { LAB_ARCHIVE_TITLE } from './document-path';
import { documentView, isLabArchiveDocument, LAB_ARCHIVE_FLAG, pendingRowsFor, saveDocuments, type DocumentPayload, type DocumentSaveIO } from './document-save';

const bytes = (text: string) => new TextEncoder().encode(text);
const hashOf = (b: Uint8Array) => `sha256-${createHash('sha256').update(b).digest('hex')}`;
const letter = (over: Partial<DocumentPayload<Uint8Array>> = {}): DocumentPayload<Uint8Array> => ({
  documentType: 'clinic_letter', title: 'Synthetic letter', documentDate: '2026-01-01',
  contentMd: 'Synthetic note', metadata: {}, sourceFileName: 'synthetic.pdf', file: bytes('letter bytes'), ...over,
});
const labArchive = (over: Partial<DocumentPayload<Uint8Array>> = {}) => letter({
  documentType: 'pathology_report', title: LAB_ARCHIVE_TITLE, contentMd: '', metadata: { [LAB_ARCHIVE_FLAG]: true }, ...over,
});

function io(opts: { fail?: boolean } = {}) {
  const written = new Map<string, Uint8Array>();
  const errors: unknown[] = [];
  let n = 0;
  const value: DocumentSaveIO<Uint8Array> = {
    hash: async (b) => hashOf(b),
    write: async (ref, b) => {
      if (opts.fail) throw new Error('synthetic quota refusal');
      written.set(ref, b);
    },
    mimeType: () => 'application/pdf',
    onWriteError: (e) => errors.push(e),
    now: () => '2026-02-01T00:00:00.000Z',
    newId: () => `doc-${++n}`,
  };
  return { io: value, written, errors };
}

const fresh = (): RoadmapFile => createEmptyFile({ deviceId: 'test', now: '2026-01-01T00:00:00.000Z' });
const row = (over: Partial<FileDocument>): FileDocument => ({
  id: 'held', title: 'Synthetic letter', type: 'clinic_letter', date: '2026-01-01', fileRef: '', contentHash: hashOf(bytes('letter bytes')),
  mimeType: '', extractedText: 'Synthetic note', addedAt: '2026-01-01T00:00:00.000Z', metadata: {}, sourceFileName: 'synthetic.pdf', ...over,
});

async function save(file: RoadmapFile, payloads: DocumentPayload<Uint8Array>[], opts: { fail?: boolean } = {}) {
  const t = io(opts);
  const plan = await saveDocuments(file, payloads, t.io);
  plan.commit(file);
  return { plan, ...t };
}

describe('saveDocuments: blob first, then the row (US-13 AC1)', () => {
  it('writes the blob at its organised path and appends a row that points at it', async () => {
    const file = fresh();
    const { plan, written } = await save(file, [letter()]);
    expect([...written.keys()]).toEqual(['Clinic letters/2026-01-01 Synthetic letter.pdf']);
    expect(plan.saved).toEqual([{
      id: 'doc-1', title: 'Synthetic letter', type: 'clinic_letter', date: '2026-01-01',
      fileRef: 'Clinic letters/2026-01-01 Synthetic letter.pdf', contentHash: hashOf(bytes('letter bytes')), mimeType: 'application/pdf',
      extractedText: 'Synthetic note', addedAt: '2026-02-01T00:00:00.000Z', metadata: {}, sourceFileName: 'synthetic.pdf',
    }]);
    expect(plan.unstored).toBe(0);
    expect(file.documents).toEqual(plan.saved);
  });

  it('changes nothing in the file until commit', async () => {
    const file = fresh();
    const plan = await saveDocuments(file, [letter()], io().io);
    expect(file.documents).toHaveLength(0);
    expect(plan.saved).toHaveLength(1);
  });

  it('a text-only document is a row with no blob, hash or MIME type', async () => {
    const { plan, written } = await save(fresh(), [letter({ file: undefined })]);
    expect(written.size).toBe(0);
    expect(plan.saved[0]).toMatchObject({ fileRef: '', contentHash: '', mimeType: '' });
  });

  it('two documents with the same name get collision-safe refs', async () => {
    const { written } = await save(fresh(), [letter(), letter({ file: bytes('other bytes') })]);
    expect([...written.keys()]).toEqual(['Clinic letters/2026-01-01 Synthetic letter.pdf', 'Clinic letters/2026-01-01 Synthetic letter (2).pdf']);
  });
});

describe('saveDocuments: content-hash dedup (US-35 AC6)', () => {
  it('an original the archive holds is a no-op; a duplicate within the batch saves once', async () => {
    const file = fresh();
    await save(file, [letter(), letter()]);
    expect(file.documents).toHaveLength(1);
    const again = await save(file, [letter()]);
    expect(again.plan.saved).toHaveLength(0);
    expect(again.written.size).toBe(0);
    expect(file.documents).toHaveLength(1);
  });

  it('a tombstoned original does not block a re-upload', async () => {
    const file = fresh();
    file.documents.push(row({ fileRef: 'Clinic letters/old.pdf', deleted: true }));
    expect((await save(file, [letter()])).plan.saved).toHaveLength(1);
  });
});

describe('saveDocuments: a held metadata-only row (US-14 AC4, US-35 AC8)', () => {
  it('a stored blob tombstones the held row of its kind and appends the row with the blob', async () => {
    const file = fresh();
    file.documents.push(row({}));
    const { plan } = await save(file, [letter()]);
    expect(file.documents.find((d) => d.id === 'held')?.deleted).toBe(true);
    expect(file.documents.filter((d) => !d.deleted)).toEqual(plan.saved);
    expect(plan.saved[0].fileRef).toBeTruthy();
  });

  it('a held row of the other kind stays: a lab archive never tombstones a letter', async () => {
    const file = fresh();
    file.documents.push(row({}));
    await save(file, [labArchive()]);
    expect(file.documents.find((d) => d.id === 'held')?.deleted).toBeUndefined();
  });

  it('a repeat failure, details unchanged, files no row: settled and counted unstored', async () => {
    const file = fresh();
    file.documents.push(row({}));
    const { plan, errors } = await save(file, [letter()], { fail: true });
    expect(errors).toHaveLength(1);
    expect(plan.saved).toHaveLength(0);
    expect(plan.unstored).toBe(1);
    expect(file.documents).toEqual([row({})]);
  });

  it('a repeat failure with a reviewed title files a new metadata-only row and replaces the held one', async () => {
    const file = fresh();
    file.documents.push(row({}));
    const { plan } = await save(file, [letter({ title: 'Reviewed title' })], { fail: true });
    expect(plan.unstored).toBe(1);
    expect(plan.saved).toEqual([expect.objectContaining({ title: 'Reviewed title', fileRef: '', contentHash: hashOf(bytes('letter bytes')) })]);
    expect(file.documents.find((d) => d.id === 'held')?.deleted).toBe(true);
  });

  it('commit replaces a same-hash row that arrived after the uploads began', async () => {
    const file = fresh();
    const plan = await saveDocuments(file, [letter()], io().io);
    file.documents.push(row({ id: 'merged-in' }));
    plan.commit(file);
    expect(file.documents.find((d) => d.id === 'merged-in')?.deleted).toBe(true);
  });
});

describe('saveDocuments: a failed blob write without a held row', () => {
  it('degrades to a metadata-only row that keeps the hash, and reports the error', async () => {
    const file = fresh();
    const { plan, errors } = await save(file, [letter()], { fail: true });
    expect(errors).toHaveLength(1);
    expect(plan.unstored).toBe(0);
    expect(plan.saved).toEqual([expect.objectContaining({ fileRef: '', mimeType: '', contentHash: hashOf(bytes('letter bytes')) })]);
    expect(file.documents).toHaveLength(1);
  });
});

describe('saveDocuments: the upload pool', () => {
  it('runs the first write into each folder alone, then at most three at once', async () => {
    let active = 0;
    let peak = 0;
    const order: string[] = [];
    const t = io();
    t.io.write = async (ref) => {
      order.push(ref);
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, 1));
      active--;
    };
    const payloads = Array.from({ length: 6 }, (_, i) => letter({ title: `L${i}`, file: bytes(`b${i}`) }));
    await saveDocuments(fresh(), [labArchive(), ...payloads], t.io);
    expect(order.slice(0, 2)).toEqual(['Lab results/2026-01-01 Blood test results.pdf', 'Clinic letters/2026-01-01 L0.pdf']);
    expect(peak).toBe(3);
  });
});

describe('documentView', () => {
  it('maps a row to the surfaces\' shape, empty ref and hash as null', () => {
    expect(documentView(row({ contentHash: '', metadata: undefined, sourceFileName: undefined }))).toEqual({
      id: 'held', documentType: 'clinic_letter', title: 'Synthetic letter', documentDate: '2026-01-01', contentMd: 'Synthetic note',
      metadata: {}, sourceFileName: null, createdAt: '2026-01-01T00:00:00.000Z', fileRef: null, contentHash: null,
    });
  });
});

describe('pendingRowsFor', () => {
  const view = (over: Partial<FileDocument>) => documentView(row(over));
  it('returns the live metadata-only rows of one kind for these bytes, newest first', () => {
    const hash = hashOf(bytes('letter bytes'));
    const rows = [
      view({ id: 'old', addedAt: '2026-01-01T00:00:00.000Z' }),
      view({ id: 'new', addedAt: '2026-01-03T00:00:00.000Z' }),
      view({ id: 'stored', fileRef: 'Clinic letters/x.pdf' }),
      view({ id: 'lab', type: 'pathology_report', title: LAB_ARCHIVE_TITLE, extractedText: '' }),
      view({ id: 'other-bytes', contentHash: 'sha256-other' }),
    ];
    expect(pendingRowsFor(rows, hash, false).map((d) => d.id)).toEqual(['new', 'old']);
    expect(pendingRowsFor(rows, hash, true).map((d) => d.id)).toEqual(['lab']);
    expect(pendingRowsFor(rows, null, false)).toEqual([]);
  });
});

describe('isLabArchiveDocument', () => {
  it('hides synthesized blood-test archive entries (explicit flag)', () => {
    expect(isLabArchiveDocument({
      documentType: 'pathology_report',
      title: 'Blood test results',
      contentMd: '',
      metadata: { [LAB_ARCHIVE_FLAG]: true },
    })).toBe(true);
  });

  it('hides legacy synthesized entries via content signature (no flag)', () => {
    expect(isLabArchiveDocument({
      documentType: 'pathology_report',
      title: 'Blood test results',
      contentMd: '',
      metadata: {},
    })).toBe(true);
  });

  it('keeps real pathology reports (biopsy/histology with content)', () => {
    expect(isLabArchiveDocument({
      documentType: 'pathology_report',
      title: 'Breast Core Biopsy — Histology',
      contentMd: '## Histology\n\nInvasive ductal carcinoma...',
      metadata: { specimenType: 'core biopsy', result: 'malignant' },
    })).toBe(false);
  });

  it('keeps clinic letters, discharge summaries, scans, vaccination records', () => {
    for (const documentType of ['clinic_letter', 'discharge_summary', 'scan_result', 'vaccination_record', 'other']) {
      expect(isLabArchiveDocument({
        documentType,
        title: 'Blood test results', // even with a colliding title, non-pathology types stay
        contentMd: '',
        metadata: {},
      })).toBe(false);
    }
  });

  it('does not hide a pathology report whose title happens to match but has content', () => {
    expect(isLabArchiveDocument({
      documentType: 'pathology_report',
      title: 'Blood test results',
      contentMd: '## Bone marrow biopsy',
      metadata: {},
    })).toBe(false);
  });
});

