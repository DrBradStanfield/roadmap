/**
 * Where a read letter's title, date and screening box start (US-13 AC6, US-14 AC4; owner ruling on PR 1957,
 * 2026-11-22: the upload state only). Four seeded properties, none of which restates the rule under test:
 * O1 the card and the box agree; O2 the letters are the same on any record, a record this Save wrote included;
 * O3 what the page showed ticked is what Save writes, while another writer adds rows for the same bytes between
 * the page, the Save and the commit; O4 every kind of such row comes up. Synthetic values, names and hashes only.
 */
import { describe, expect, it } from 'vitest';
import { documentRow, labArchiveFields } from './document-rows';
import { EMPTY, NOW } from './import-review.test-helpers';
import type { UnifiedExtractionResult } from './lab-extraction';
import type { FileDocument, RoadmapFile } from './roadmap-file';
import { NO_CHOICES, type DocumentFix } from './upload-choices';
import type { UploadFile, UploadState } from './upload-flow';
import { uploadListPage } from './upload-list-page';
import { uploadSavePlan } from './upload-plan';
import { uploadReview } from './upload-review';
import { uploadSave, type UploadSaveIO } from './upload-save';
import type { ScreeningPerson } from './upload-screening';
import { UPLOAD_TEXT } from './upload-text';
import { uploadView } from './upload-view';

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

const TYPES = ['colorectal', 'lung', 'dexa', 'knee'];
const PERSON: ScreeningPerson = { age: 60 };
/** Reader dates: a past day, a month alone, none, a day to come, text that is no date. */
const RAW = ['2026-10-20', '2026-06', null, '2027-01-01', 'junk'];
const FIX: DocumentFix[] = [{}, {}, { date: '2026-09-09' }, { date: null }, { title: 'Mine' }];
/** Rows another writer may hold for a letter's bytes, each dated unlike any reader date. */
const KINDS = ['storedDated', 'storedUndated', 'metaDated', 'metaUndated', 'labArchive', 'labArchiveStored'] as const;
type Kind = (typeof KINDS)[number];

let rowId = 0;
function row(kind: Kind, hash: string): FileDocument {
  const lab = kind.startsWith('labArchive');
  const fields = lab ? labArchiveFields('other.pdf', '2026-03-03')
    : { documentType: 'scan_result', title: `Other ${kind}`, documentDate: kind.endsWith('Undated') ? null : kind.startsWith('stored') ? '2026-04-04' : '2026-05-05', contentMd: 'text', metadata: {}, sourceFileName: 'other.pdf' };
  const d = documentRow(fields, { id: `row-${rowId++}`, contentHash: hash, mimeType: 'application/pdf', addedAt: NOW });
  return kind.startsWith('stored') || kind === 'labArchiveStored' ? { ...d, fileRef: `docs/${d.id}.pdf` } : d;
}
const withRows = (file: RoadmapFile, rows: FileDocument[]): RoadmapFile => ({ ...file, documents: [...file.documents, ...rows] });

const letter = (type: string, raw: string | null): UnifiedExtractionResult => ({
  classification: 'scan_result', reportDate: null, values: [], additionalValues: [], unrecognized: [],
  document: { classification: 'scan_result', title: 'Synthetic scan', documentDate: raw, contentMarkdown: 'Synthetic', metadata: { screeningType: type } },
});
const readFile = (id: string, hash: string, x: UnifiedExtractionResult, document: DocumentFix & { screening?: boolean }): UploadFile =>
  ({ id, name: `${id}.pdf`, bytes: 1, hash, pages: { count: 1, truncated: false }, status: { s: 'read', extraction: x, choices: { ...NO_CHOICES, document } } });
const state = (phase: 'open' | 'saving', files: UploadFile[]): UploadState =>
  (phase === 'open' ? { phase, platform: 'web', run: 1, files, started: NOW, firstRead: NOW } : { phase, platform: 'web', run: 1, files, started: NOW, firstRead: NOW, attempt: 1 });
const io = (on: boolean, failing: Set<string>): UploadSaveIO<string> => {
  let n = 0;
  return {
    holds: () => on, original: (id) => (on ? `bytes of ${id}` : null), mimeType: () => 'application/pdf', now: () => NOW, newId: () => `id-${n++}`,
    write: async (_ref, _bytes, id) => { if (!on || failing.has(id)) throw new Error('refused'); },
  };
};
const planOf = (s: UploadState, record: RoadmapFile, on: boolean) => uploadSavePlan(s, record, NOW, uploadReview(s, record, NOW), on, PERSON);
const letters = (s: UploadState, record: RoadmapFile, on: boolean) =>
  planOf(s, record, on).documents.map(({ fileId, fields, screening }) => ({ fileId, title: fields.title, documentDate: fields.documentDate, screening }));
const MONTH_WORDS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** The date a box's words name: "20 Oct 2026" is 2026-10-20, "Jun 2026" is 2026-06. */
const dateOf = (words: string) => {
  const [d, m, y] = words.split(' ').length === 3 ? words.split(' ') : [null, ...words.split(' ')];
  const month = `${y}-${String(MONTH_WORDS.indexOf(m!) + 1).padStart(2, '0')}`;
  return d ? `${month}-${d.padStart(2, '0')}` : month;
};
const dayOf = (date: string) => (date.length === 7 ? `${date}-01` : date);
/** The page's ticked boxes by key, the date its words name, the latest standing (Brad 2026-11-23). */
function shownTicked(s: UploadState, record: RoadmapFile, on: boolean): Map<string, string> {
  const page = uploadListPage(s, record, NOW, uploadReview(s, record, NOW), on, PERSON);
  const shown = new Map<string, string>();
  for (const { screening: b } of page.letters) {
    const date = b?.checked ? dateOf(/ to (.+)$/.exec(b.tail)![1]) : null;
    const key = `${b?.type}_last_date`;
    if (date && (!shown.has(key) || dayOf(date) > dayOf(shown.get(key)!))) shown.set(key, date);
  }
  return shown;
}
const field = (key: string) => key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const written = (file: RoadmapFile) => new Map(Object.entries(file.screenings as unknown as Record<string, unknown>)
  .filter(([k]) => !['updatedAt', 'lamport', 'fieldStamps'].includes(k)).map(([k, v]) => [k, v]));

interface Case { files: UploadFile[]; raw: Map<string, string | null>; fix: Map<string, DocumentFix>; hashes: string[]; on: boolean; failing: Set<string> }
function genCase(r: () => number): Case {
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  const files: UploadFile[] = [];
  const raw = new Map<string, string | null>();
  const fix = new Map<string, DocumentFix>();
  const failing = new Set<string>();
  for (let i = 0, n = 1 + Math.floor(r() * 3); i < n; i++) {
    const id = `f${i}`;
    const date = pick(RAW);
    const f = pick(FIX);
    const tick = pick([undefined, undefined, true, false]);
    raw.set(id, date);
    fix.set(id, f);
    if (r() < 0.3) failing.add(id);
    files.push(readFile(id, `h${i}`, letter(pick(TYPES), date), { ...f, ...(tick === undefined ? {} : { screening: tick }) }));
  }
  return { files, raw, fix, hashes: files.map((f) => f.hash!), on: r() < 0.5, failing };
}
/** Rows for some of the pick's bytes, of the kinds given (or any). */
function genRows(r: () => number, hashes: string[], kinds: readonly Kind[] = KINDS): Array<{ kind: Kind; row: FileDocument }> {
  const out: Array<{ kind: Kind; row: FileDocument }> = [];
  for (const h of hashes) if (r() < 0.6) { const kind = kinds[Math.floor(r() * kinds.length)]; out.push({ kind, row: row(kind, h) }); }
  return out;
}

describe('US-13 AC6, US-14 AC4: a read letter starts from the upload state, never from the record', () => {
  it('O1: on any record, a letter\'s box names the date its card saves, or a month alone the reader gave when the card has no day', () => {
    // Each branch must come up, or the property passes on nothing.
    const reach = { box: 0, day: 0, month: 0, undated: 0, sameRow: 0 };
    for (let seed = 1; seed <= 600; seed++) {
      const r = mulberry32(seed);
      const c = genCase(r);
      const record = withRows(EMPTY, genRows(r, c.hashes).map((x) => x.row));
      for (const { fileId, fields, screening: box } of planOf(state('open', c.files), record, c.on).documents) {
        if (!box) continue;
        reach.box++;
        if (record.documents.some((d) => d.contentHash === c.files.find((f) => f.id === fileId)!.hash)) reach.sameRow++;
        if (fields.documentDate !== null) { reach.day++; expect(box.date, `seed ${seed} ${fileId}`).toBe(fields.documentDate); }
        else if (box.date !== null) {
          reach.month++;
          expect(box.date, `seed ${seed} ${fileId} month`).toBe(c.raw.get(fileId));
          expect(box.date, `seed ${seed} ${fileId} month`).toMatch(/^\d{4}-\d{2}$/);
          expect('date' in c.fix.get(fileId)!, `seed ${seed} ${fileId} no date fix`).toBe(false);
        } else reach.undated++;
      }
    }
    for (const [name, n] of Object.entries(reach)) expect(n, name).toBeGreaterThan(20);
  });

  it('O2: the letters\' title, date and box are the same on any two records, and on the record this Save wrote', async () => {
    // Letters with a box and with a dated box on records that differ in their rows for those bytes: else the equality is empty.
    const reach = { box: 0, dated: 0, recordsDiffer: 0 };
    for (let seed = 1; seed <= 400; seed++) {
      const r = mulberry32(seed);
      const c = genCase(r);
      const a = withRows(EMPTY, genRows(r, c.hashes).map((x) => x.row));
      const b = withRows(EMPTY, genRows(r, c.hashes).map((x) => x.row));
      const s = state('saving', c.files);
      const onA = letters(s, a, c.on);
      reach.box += onA.filter((l) => l.screening).length;
      reach.dated += onA.filter((l) => l.screening?.date).length;
      if (JSON.stringify(a.documents.map((d) => [d.contentHash, d.title, d.date, d.fileRef])) !== JSON.stringify(b.documents.map((d) => [d.contentHash, d.title, d.date, d.fileRef]))) reach.recordsDiffer++;
      expect(letters(s, b, c.on), `seed ${seed} two records`).toEqual(onA);
      const out = await uploadSave(s, a, NOW, c.on, io(c.on, c.failing), PERSON);
      if (!out.ok) throw new Error(out.reason);
      // O2 is about rows for the letters' bytes, so the letters are compared on the committed rows with the record's
      // screening dates as they were: a date this Save wrote rightly hides every box no later than it (Brad 2026-11-23).
      // The dates it wrote are asserted apart: the latest the page showed ticked per type, and nothing else.
      const committed = out.commit(a).file;
      expect(letters(s, { ...committed, screenings: a.screenings }, c.on), `seed ${seed} after commit`).toEqual(onA);
      expect(written(committed), `seed ${seed} dates`).toEqual(new Map([...shownTicked(state('open', c.files), a, c.on)].map(([k, v]) => [field(k), v])));
    }
    for (const [name, n] of Object.entries(reach)) expect(n, name).toBeGreaterThan(50);
  });

  it('O3, O4: the dates written are the page\'s ticked dates when another writer adds rows for the same bytes between page, Save and commit', async () => {
    const reach: Record<string, number> = { cloudOn: 0, cloudOff: 0, writeFailed: 0 };
    for (const k of KINDS) { reach[`beforeSave ${k}`] = 0; reach[`beforeCommit ${k}`] = 0; reach[`monthOnly ${k}`] = 0; }
    for (let seed = 1; seed <= 900; seed++) {
      const r = mulberry32(seed);
      const c = genCase(r);
      const pageRecord = withRows(EMPTY, r() < 0.3 ? genRows(r, c.hashes).map((x) => x.row) : []);
      const toSave = genRows(r, c.hashes);
      const toCommit = genRows(r, c.hashes);
      const saveRecord = withRows(pageRecord, toSave.map((x) => x.row));
      const commitRecord = withRows(saveRecord, toCommit.map((x) => x.row));
      const shown = shownTicked(state('open', c.files), pageRecord, c.on);
      const out = await uploadSave(state('saving', c.files), saveRecord, NOW, c.on, io(c.on, c.failing), PERSON);
      if (!out.ok) throw new Error(out.reason);
      const { file } = out.commit(commitRecord);
      expect(written(file), `seed ${seed}`).toEqual(new Map([...shown].map(([k, v]) => [field(k), v])));
      if (!shown.size) continue;
      reach[c.on ? 'cloudOn' : 'cloudOff']++;
      if (c.on && c.files.some((f) => c.failing.has(f.id))) reach.writeFailed++;
      const monthOnly = new Set(c.files.filter((f) => /^\d{4}-\d{2}$/.test(c.raw.get(f.id) ?? '') && !('date' in c.fix.get(f.id)!)).map((f) => f.hash));
      for (const { kind, row: x } of toSave) { reach[`beforeSave ${kind}`]++; if (monthOnly.has(x.contentHash)) reach[`monthOnly ${kind}`]++; }
      for (const { kind, row: x } of toCommit) { reach[`beforeCommit ${kind}`]++; if (monthOnly.has(x.contentHash)) reach[`monthOnly ${kind}`]++; }
    }
    for (const [name, n] of Object.entries(reach)) expect(n, name).toBeGreaterThan(3);
  });

  it('the iPhone: a metadata-only row for the same bytes that lands during the review is replaced by the title and date the card shows', async () => {
    for (const on of [false, true]) {
      for (const kind of ['metaDated', 'metaUndated'] as const) {
        const files = [readFile('f0', 'h0', letter('colorectal', '2026-10-20'), {})];
        const s: UploadState = { phase: 'saving', platform: 'phone', run: 1, files, started: NOW, firstRead: NOW, attempt: 1 };
        const page = uploadView({ ...s, phase: 'open' } as UploadState, EMPTY, NOW, uploadReview(s, EMPTY, NOW), on).documents!.rows[0];
        const record = withRows(EMPTY, [row(kind, 'h0')]);
        const out = await uploadSave(s, record, NOW, on, io(on, new Set()));
        if (!out.ok) throw new Error(out.reason);
        const { file } = out.commit(record);
        const live = file.documents.filter((d) => !d.deleted && d.contentHash === 'h0');
        expect(live.map((d) => [d.title, d.date]), `${kind} cloud ${on}`).toEqual([[page.title, page.day]]);
        expect(written(file).size, `${kind} cloud ${on}`).toBe(0);
      }
    }
  });
});

describe('US-13 AC6: a read letter\'s start, edge cases', () => {
  const one = (x: UnifiedExtractionResult, fix: DocumentFix & { screening?: boolean } = {}) => [readFile('f0', 'h0', x, fix)];

  it('a decoded date fix that is no possible past day is never planned: the card and the box both keep the reader\'s date, and agree', () => {
    for (const date of ['2026-02-30', '2027-01-01', 'junk', '2026-13-01']) {
      const [{ fields, screening }] = planOf(state('open', one(letter('colorectal', '2026-10-20'), { date })), EMPTY, false).documents;
      expect([fields.documentDate, screening?.date], date).toEqual(['2026-10-20', '2026-10-20']);
    }
  });

  it('a screening type that is not a string gives no box', () => {
    for (const screeningType of [42, true, ['colorectal'], { type: 'colorectal' }, null]) {
      const x = letter('colorectal', '2026-10-20');
      x.document = { ...x.document!, metadata: { screeningType } };
      expect(planOf(state('open', one(x)), EMPTY, false).documents[0].screening, JSON.stringify(screeningType)).toBeUndefined();
    }
  });

  // KNOWN (same as main): the page and Save each judge "a day to come" by their own clock, so a reader day still to come on the
  // page shows a disabled box, and a Save on a later day may write that date. The gap spans two days so the pin holds in any time zone.
  it('KNOWN: a reader day still to come when the page is drawn, past when Save runs, is written though the page showed the box disabled', async () => {
    const [page, save] = ['2026-11-01T12:00:00.000Z', '2026-11-03T12:00:00.000Z'];
    const files = one(letter('colorectal', '2026-11-03'));
    const open = state('open', files);
    const drawn = uploadListPage(open, EMPTY, page, uploadReview(open, EMPTY, page), false, PERSON).letters[0];
    expect(drawn.screening).toMatchObject({ checked: false, disabled: true });
    expect(drawn.pickerLine).toBe(UPLOAD_TEXT.setDate);
    const out = await uploadSave(state('saving', files), EMPTY, save, false, io(false, new Set()), PERSON);
    if (!out.ok) throw new Error(out.reason);
    const { file } = out.commit(EMPTY);
    expect(written(file)).toEqual(new Map([['colorectalLastDate', '2026-11-03']]));
    expect(file.documents.map((d) => d.date)).toEqual(['2026-11-03']);
  });

  // KNOWN (adversary R1 on PR 1957; main behaves the same; a lead): a pick holding two copies of one file's bytes, the first known
  // (hashed after a metadata-only row landed) and the second read, plans the read copy only when the held row is gone at plan time.
  it('KNOWN: the held row tombstoned between page and Save changes whether the read copy of the same bytes is planned', async () => {
    const files: UploadFile[] = [
      { id: 'k', name: 'k.pdf', bytes: 1, hash: 'h0', pages: { count: 1, truncated: false }, status: { s: 'known', as: 'document', archiveOnly: true } },
      readFile('f0', 'h0', letter('colorectal', '2026-10-20'), { screening: true }),
    ];
    const held = row('metaDated', 'h0');
    const pageRecord = withRows(EMPTY, [held]);
    const saveRecord = { ...EMPTY, documents: [{ ...held, deleted: true }] };
    const open = state('open', files);
    expect(uploadListPage(open, pageRecord, NOW, uploadReview(open, pageRecord, NOW), true, PERSON).letters).toEqual([]);
    expect(planOf(state('saving', files), saveRecord, true).documents.map((d) => [d.fileId, d.screening?.date])).toEqual([['f0', '2026-10-20']]);
    const out = await uploadSave(state('saving', files), saveRecord, NOW, true, io(true, new Set()), PERSON);
    if (!out.ok) throw new Error(out.reason);
    expect(written(out.commit(saveRecord).file)).toEqual(new Map([['colorectalLastDate', '2026-10-20']]));
  });
});
