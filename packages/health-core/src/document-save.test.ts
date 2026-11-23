// US-13 AC1, US-14 AC4, US-35 AC6/AC8: health-core's one document-save rule,
// shared by the website and the iPhone app. Bytes are Uint8Array here, as on
// the phone. Synthetic bytes only.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createEmptyFile, createLabValue, type FileDocument, type RoadmapFile } from './roadmap-file';
import { knownAs, knownIndex } from './upload-known';
import { LAB_ARCHIVE_TITLE } from './document-path';
import { documentView, isLabArchiveDocument, labArchivePayload, pendingRowsFor, saveDocuments, type DocumentPayload, type DocumentSaveIO } from './document-save';
import { LAB_ARCHIVE_FLAG, LAB_ARCHIVE_ROWS, labRowsByFile, listedRows, writtenLabRows } from './document-rows';
import { bulkAppendValues } from './record-edits';

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
    stopped: () => false, hash: async (b) => hashOf(b),
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
  it('degrades to a metadata-only row that keeps the hash, reports the error and counts it unstored (US-14 AC12)', async () => {
    const file = fresh();
    const { plan, errors } = await save(file, [letter()], { fail: true });
    expect(errors).toHaveLength(1);
    expect(plan.unstored).toBe(1);
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

describe('saveDocuments: the rows, byte for byte (US-52 AC14)', () => {
  it('a letter and a lab report\'s archive row: the bytes the web and the iPhone write', async () => {
    let ids = 0;
    let clock = 0;
    const t = io();
    const plan = await saveDocuments(fresh(), [letter(), labArchivePayload('labs.pdf', '2026-01-02', bytes('lab bytes'))], {
      ...t.io, newId: () => `doc-${++ids}`, now: () => `2026-02-01T00:00:0${clock++}.000Z`,
    });
    expect(JSON.stringify(plan.saved)).toMatchSnapshot();
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


// US-14 AC10: a save with no cloud keeps the file's hash; a lab archive row
// lists the value rows its import wrote, and a re-read of a report whose
// listed values are all gone files a copy listing the new ones.
describe('saveDocuments: the hash without the bytes, and lab archive row lists (US-14 AC10)', () => {
  const hash = hashOf(bytes('letter bytes'));
  const offCloud = (over: Partial<DocumentPayload<Uint8Array>> = {}) => letter({ file: undefined, contentHash: hash, ...over });
  const labRow = (id: string, status: 'active' | 'entered-in-error' = 'active') => createLabValue({
    id, metricName: 'ferritin', value: 1, unit: 'µg/L', recordedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', source: 'lab_import', status,
  });

  it('no bytes, a hash: a metadata-only row carrying it, nothing written, nothing unstored; the record then knows the file', async () => {
    const file = fresh();
    const { plan, written } = await save(file, [offCloud()]);
    expect(written.size).toBe(0);
    expect(plan.unstored).toBe(0);
    expect(file.documents).toEqual([expect.objectContaining({ contentHash: hash, fileRef: '', mimeType: '', extractedText: 'Synthetic note' })]);
    expect(knownAs(knownIndex(file), hash)).toEqual({ as: 'document', archiveOnly: true });
  });

  it('the same file again, as held: nothing new; edited (title, type or date): it replaces the held row, as a cloud upload does (adversary F3)', async () => {
    const file = fresh();
    await save(file, [offCloud()]);
    expect((await save(file, [offCloud()])).plan.saved).toEqual([]);
    for (const edit of [{ title: 'Renamed' }, { documentType: 'discharge_summary' }, { documentDate: '2026-01-05' }]) {
      const current = file.documents.find((d) => !d.deleted)!;
      const next = { title: current.title, documentType: current.type, documentDate: current.date, ...edit };
      expect((await save(file, [offCloud(next)])).plan.saved).toHaveLength(1);
      expect(file.documents.filter((d) => !d.deleted)).toEqual([expect.objectContaining({ ...('title' in edit ? { title: 'Renamed' } : null), contentHash: hash, fileRef: '' })]);
    }
    expect(file.documents.filter((d) => !d.deleted)[0]).toMatchObject({ title: 'Renamed', type: 'discharge_summary', date: '2026-01-05' });
    expect(file.documents.filter((d) => d.deleted)).toHaveLength(3);
    // With a cloud the same edit lands the original and replaces the held row: the two paths agree.
    const cloud = fresh();
    await save(cloud, [offCloud()]);
    await save(cloud, [letter({ title: 'Renamed' })]);
    expect(cloud.documents.filter((d) => !d.deleted)).toEqual([expect.objectContaining({ title: 'Renamed', contentHash: hash, fileRef: expect.stringMatching(/^Clinic letters\//) })]);
  });

  it('later, with a cloud: the original is filed behind the metadata-only row (US-14 AC4)', async () => {
    const file = fresh();
    await save(file, [offCloud()]);
    const { written } = await save(file, [letter()]);
    expect(written.size).toBe(1);
    expect(file.documents.filter((d) => !d.deleted)).toEqual([expect.objectContaining({ contentHash: hash, fileRef: expect.stringMatching(/^Clinic letters\//) })]);
  });

  it('a lab archive row lists its rows; with none written, no list', () => {
    expect(labArchivePayload('a.pdf', '2026-01-01', undefined, { rows: ['lv-1', 'lv-2'] }).metadata).toEqual({ [LAB_ARCHIVE_FLAG]: true, [LAB_ARCHIVE_ROWS]: ['lv-1', 'lv-2'] });
    expect(labArchivePayload('a.pdf', '2026-01-01', undefined, { rows: [] }).metadata).toEqual({ [LAB_ARCHIVE_FLAG]: true });
  });

  it('a report whose listed values are all gone, read again: a copy with the same original and the new list, the old row tombstoned, no second blob', async () => {
    const file = fresh();
    file.labValues = [labRow('lv-1', 'entered-in-error'), labRow('lv-2')];
    file.documents = [row({ id: 'dead', type: 'pathology_report', title: LAB_ARCHIVE_TITLE, extractedText: '', fileRef: 'Lab results/a.pdf', mimeType: 'application/pdf', metadata: { [LAB_ARCHIVE_FLAG]: true, [LAB_ARCHIVE_ROWS]: ['lv-1'] } })];
    expect(knownAs(knownIndex(file), hash)).toBeNull();
    const { plan, written } = await save(file, [labArchive({ metadata: { [LAB_ARCHIVE_FLAG]: true, [LAB_ARCHIVE_ROWS]: ['lv-2'] } })]);
    expect(written.size).toBe(0);
    expect(plan.saved).toEqual([expect.objectContaining({ fileRef: 'Lab results/a.pdf', mimeType: 'application/pdf', contentHash: hash, metadata: { [LAB_ARCHIVE_FLAG]: true, [LAB_ARCHIVE_ROWS]: ['lv-1', 'lv-2'] } })]);
    expect(file.documents.find((d) => d.id === 'dead')?.deleted).toBe(true);
    expect(knownAs(knownIndex(file), hash)).toEqual({ as: 'labReport', archiveOnly: false });
  });

  it('a dead lab archive row beside a metadata-only letter of the same bytes: the letter is filed behind its row, and the record and the save agree', async () => {
    const file = fresh();
    file.labValues = [labRow('lv-1', 'entered-in-error')];
    file.documents = [
      row({ id: 'dead', type: 'pathology_report', title: LAB_ARCHIVE_TITLE, extractedText: '', fileRef: 'Lab results/a.pdf', metadata: { [LAB_ARCHIVE_FLAG]: true, [LAB_ARCHIVE_ROWS]: ['lv-1'] } }),
      row({ id: 'held' }),
    ];
    expect(knownAs(knownIndex(file), hash)).toEqual({ as: 'document', archiveOnly: true });
    const { written } = await save(file, [letter()]);
    expect(written.size).toBe(1);
    expect(file.documents.find((d) => d.id === 'held')?.deleted).toBe(true);
    expect(knownAs(knownIndex(file), hash)).toEqual({ as: 'document', archiveOnly: false });
  });
});

describe('writtenLabRows / labRowsByFile: what each file wrote (US-14 AC10)', () => {
  it('a written lab row by its root id; a vital, a skip or a refusal is null; grouped by file', () => {
    const write = {
      saved: [{ id: 'm-1', metricType: 'weight' }, { id: 'l-1#si', metricName: 'ferritin' }, { id: 'l-2', metricName: 'hba1c' }],
      outcomes: ['written', 'skipped', 'written', 'refused', 'written'] as const,
    };
    const rows = writtenLabRows({ saved: write.saved, outcomes: [...write.outcomes] });
    expect(rows).toEqual([null, null, 'l-1', null, 'l-2']);
    expect(labRowsByFile(rows, ['a.pdf', 'a.pdf', 'a.pdf', 'b.pdf', undefined])).toEqual(new Map([['a.pdf', ['l-1']]]));
    expect(labRowsByFile(rows, ['a.pdf', 'a.pdf', 'b.pdf', 'b.pdf', 'b.pdf'])).toEqual(new Map([['b.pdf', ['l-1', 'l-2']]]));
  });
});

// Codex R2, adversary F1: a live lab archive row's list is kept and extended, never lost.
describe('saveDocuments: a lab archive row\'s list is kept and extended (US-14 AC10)', () => {
  const hash = hashOf(bytes('letter bytes'));
  const labRow = (id: string, status: 'active' | 'entered-in-error' = 'active') => createLabValue({
    id, metricName: 'ferritin', value: 1, unit: 'µg/L', recordedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', source: 'lab_import', status,
  });
  const listing = (rows: string[] | null, over: Partial<FileDocument> = {}) => row({
    id: 'held', type: 'pathology_report', title: LAB_ARCHIVE_TITLE, extractedText: '', metadata: { [LAB_ARCHIVE_FLAG]: true, ...(rows ? { [LAB_ARCHIVE_ROWS]: rows } : null) }, ...over,
  });
  const offCloudLab = (rows: string[]) => labArchivePayload<Uint8Array>('a.pdf', '2026-01-01', undefined, { rows, contentHash: hash });
  const live = (file: RoadmapFile) => file.documents.filter((d) => !d.deleted);

  it('off-cloud: core values saved, the rest failed, the row lists the core; the retry saves the rest: one live row lists both; the core deleted, still known', async () => {
    const file = fresh();
    file.labValues = [labRow('core-1')];
    await save(file, [offCloudLab(['core-1'])]);
    expect(live(file)).toEqual([expect.objectContaining({ metadata: { [LAB_ARCHIVE_FLAG]: true, [LAB_ARCHIVE_ROWS]: ['core-1'] } })]);
    file.labValues.push(labRow('add-1'));
    // The retry's own write lists only what it wrote: the save keeps the held list and adds it.
    await save(file, [offCloudLab(['add-1'])]);
    expect(live(file)).toEqual([expect.objectContaining({ fileRef: '', contentHash: hash, metadata: { [LAB_ARCHIVE_FLAG]: true, [LAB_ARCHIVE_ROWS]: ['core-1', 'add-1'] } })]);
    file.labValues[0] = { ...file.labValues[0], status: 'entered-in-error' };
    expect(knownAs(knownIndex(file), hash)).toEqual({ as: 'labReport', archiveOnly: true });
  });

  it('nothing new to list and no original to file: nothing written', async () => {
    const file = fresh();
    file.labValues = [labRow('lv-1')];
    file.documents = [listing(['lv-1'])];
    expect((await save(file, [offCloudLab(['lv-1'])])).plan.saved).toEqual([]);
    expect((await save(file, [offCloudLab([])])).plan.saved).toEqual([]);
    file.documents = [listing(['lv-1'], { fileRef: 'Lab results/a.pdf' })];
    const { plan, written } = await save(file, [labArchive({ metadata: { [LAB_ARCHIVE_FLAG]: true, [LAB_ARCHIVE_ROWS]: ['lv-1'] } })]);
    expect([plan.saved, written.size]).toEqual([[], 0]);
  });

  it('a lab report saved off-cloud, then uploaded with a cloud (US-14 AC4 for a lab report): the original is filed behind, the list kept', async () => {
    const file = fresh();
    file.labValues = [labRow('lv-1')];
    file.documents = [listing(['lv-1'])];
    // The phone lists no rows: the held list stays.
    const { written } = await save(file, [labArchive()]);
    expect(written.size).toBe(1);
    expect(live(file)).toEqual([expect.objectContaining({ fileRef: expect.stringMatching(/^Lab results\//), contentHash: hash, metadata: { [LAB_ARCHIVE_FLAG]: true, [LAB_ARCHIVE_ROWS]: ['lv-1'] } })]);
    expect(file.documents.find((d) => d.id === 'held')?.deleted).toBe(true);
  });

  it('a stored, known row and new rows to list: a copy with the same original and the union, no blob', async () => {
    const file = fresh();
    file.labValues = [labRow('lv-1'), labRow('lv-2')];
    file.documents = [listing(['lv-1'], { fileRef: 'Lab results/a.pdf', mimeType: 'application/pdf' })];
    const { written } = await save(file, [labArchive({ metadata: { [LAB_ARCHIVE_FLAG]: true, [LAB_ARCHIVE_ROWS]: ['lv-2'] } })]);
    expect(written.size).toBe(0);
    expect(live(file)).toEqual([expect.objectContaining({ fileRef: 'Lab results/a.pdf', metadata: { [LAB_ARCHIVE_FLAG]: true, [LAB_ARCHIVE_ROWS]: ['lv-1', 'lv-2'] } })]);
  });

  it('two different files under one name (different bytes, different days): each row lists only its own; one report\'s values deleted, only that one is not known', async () => {
    const file = fresh();
    const write = bulkAppendValues(file, [
      { kind: 'lab', metricName: 'Ferritin', value: 90, unit: 'µg/L', recordedAt: '2026-01-01', source: 'lab_import' },
      { kind: 'lab', metricName: 'Ferritin', value: 70, unit: 'µg/L', recordedAt: '2026-02-01', source: 'lab_import' },
    ], '2026-02-02T00:00:00.000Z');
    // Keyed by each file's identity (its hash), never the shared name.
    const rows = labRowsByFile(writtenLabRows(write), ['hash-first', 'hash-second']);
    await save(write.file, [
      labArchivePayload<Uint8Array>('Results.pdf', '2026-01-01', undefined, { rows: rows.get('hash-first'), contentHash: 'hash-first' }),
      labArchivePayload<Uint8Array>('Results.pdf', '2026-02-01', undefined, { rows: rows.get('hash-second'), contentHash: 'hash-second' }),
    ]);
    const [first, second] = write.file.labValues.map((r) => r.id);
    expect(live(write.file).map((d) => [d.contentHash, listedRows(d)])).toEqual([['hash-first', [first]], ['hash-second', [second]]]);
    write.file.labValues[0] = { ...write.file.labValues[0], status: 'entered-in-error' };
    const index = knownIndex(write.file);
    expect([knownAs(index, 'hash-first'), knownAs(index, 'hash-second')]).toEqual([null, { as: 'labReport', archiveOnly: true }]);
  });

  it('a replacement never loses a stored original: the blob write fails while another device\'s stored archive (listing B) merges in', async () => {
    const current = fresh();
    current.labValues = [labRow('A'), labRow('B')];
    // Nothing held here: this save's own row lists A.
    const plan = await saveDocuments(current, [labArchive({ metadata: { [LAB_ARCHIVE_FLAG]: true, [LAB_ARCHIVE_ROWS]: ['A'] } })], io({ fail: true }).io);
    const atCommit = structuredClone(current);
    atCommit.documents.push(listing(['B'], { id: 'other-device', fileRef: 'Lab results/other.pdf', mimeType: 'application/pdf' }));
    plan.commit(atCommit);
    // The replaced rows' list first, then this save's own.
    expect(live(atCommit)).toEqual([expect.objectContaining({ fileRef: 'Lab results/other.pdf', mimeType: 'application/pdf', metadata: { [LAB_ARCHIVE_FLAG]: true, [LAB_ARCHIVE_ROWS]: ['B', 'A'] } })]);
  });

  it('a replacement never loses a stored original: an off-cloud save meets a stored archive merged in', async () => {
    const current = fresh();
    current.labValues = [labRow('A'), labRow('B')];
    current.documents = [listing(['A'])];
    const plan = await saveDocuments(current, [labArchivePayload<Uint8Array>('a.pdf', '2026-01-01', undefined, { rows: ['A', 'C'], contentHash: hash })], io().io);
    const atCommit = structuredClone(current);
    atCommit.documents.push(listing(['B'], { id: 'other-device', fileRef: 'Lab results/other.pdf', mimeType: 'application/pdf' }));
    plan.commit(atCommit);
    expect(live(atCommit)).toEqual([expect.objectContaining({ fileRef: 'Lab results/other.pdf', mimeType: 'application/pdf', metadata: { [LAB_ARCHIVE_FLAG]: true, [LAB_ARCHIVE_ROWS]: ['A', 'B', 'C'] } })]);
  });

  it('Codex re-check 1: the list is built at commit, from the rows the commit tombstones: a second device\'s row that arrived during the blob write keeps its value', async () => {
    const current = fresh();
    current.labValues = [labRow('A'), labRow('B')];
    current.documents = [listing(['A'])];
    const t = io();
    const plan = await saveDocuments(current, [labArchive()], t.io);
    // Merged in from another device while the original uploaded: the same bytes, listing B.
    const atCommit = structuredClone(current);
    atCommit.documents.push(listing(['B'], { id: 'other-device' }));
    plan.commit(atCommit);
    expect(live(atCommit)).toEqual([expect.objectContaining({ fileRef: expect.stringMatching(/^Lab results\//), metadata: { [LAB_ARCHIVE_FLAG]: true, [LAB_ARCHIVE_ROWS]: ['A', 'B'] } })]);
    atCommit.labValues[0] = { ...atCommit.labValues[0], status: 'entered-in-error' };
    expect(knownAs(knownIndex(atCommit), hash)).toEqual({ as: 'labReport', archiveOnly: false });
  });
});

// Codex re-check 3, US-65 AC3: an unreadable stored row never throws and is never touched.
describe('isLabArchiveDocument and the save are total over stored shapes (US-65 AC3)', () => {
  it('never throws; what it cannot read is not a lab archive row', () => {
    const shapes: unknown[] = [null, 3, 'x', {}, { documentType: 'pathology_report', title: LAB_ARCHIVE_TITLE, contentMd: 3, metadata: {} },
      { documentType: 3, title: { a: 1 }, contentMd: null, metadata: 'x' }, { documentType: 'pathology_report', title: LAB_ARCHIVE_TITLE, contentMd: {}, metadata: null }];
    for (const shape of shapes) expect(isLabArchiveDocument(shape as Parameters<typeof isLabArchiveDocument>[0])).toBe(false);
  });

  it('a stored row with the archive signature, a row list and extractedText 3: knownIndex and saveDocuments do not throw and leave it as it was', async () => {
    const file = fresh();
    const odd = { ...row({ id: 'odd', type: 'pathology_report', title: LAB_ARCHIVE_TITLE, metadata: { [LAB_ARCHIVE_ROWS]: ['x'] } }), extractedText: 3 } as unknown as FileDocument;
    file.documents = [odd];
    expect(() => knownIndex(file)).not.toThrow();
    const before = structuredClone(odd);
    await save(file, [labArchive()]);
    expect(file.documents[0]).toEqual(before);
  });
});
