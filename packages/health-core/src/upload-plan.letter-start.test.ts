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
/** The page's ticked boxes by key, the date its words name, the later in page order standing. */
function shownTicked(s: UploadState, record: RoadmapFile, on: boolean): Map<string, string> {
  const page = uploadListPage(s, record, NOW, uploadReview(s, record, NOW), on, PERSON);
  return new Map(page.letters.flatMap(({ screening: b }) => (b?.checked ? [[`${b.type}_last_date`, / to (\S+)$/.exec(b.tail)![1]] as const] : [])));
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
    for (let seed = 1; seed <= 600; seed++) {
      const r = mulberry32(seed);
      const c = genCase(r);
      const record = withRows(EMPTY, genRows(r, c.hashes).map((x) => x.row));
      for (const { fileId, fields, screening: box } of planOf(state('open', c.files), record, c.on).documents) {
        if (!box) continue;
        if (fields.documentDate !== null) expect(box.date, `seed ${seed} ${fileId}`).toBe(fields.documentDate);
        else if (box.date !== null) {
          expect(box.date, `seed ${seed} ${fileId} month`).toBe(c.raw.get(fileId));
          expect(box.date, `seed ${seed} ${fileId} month`).toMatch(/^\d{4}-\d{2}$/);
          expect('date' in c.fix.get(fileId)!, `seed ${seed} ${fileId} no date fix`).toBe(false);
        }
      }
    }
  });

  it('O2: the letters\' title, date and box are the same on any two records, and on the record this Save wrote', async () => {
    for (let seed = 1; seed <= 400; seed++) {
      const r = mulberry32(seed);
      const c = genCase(r);
      const a = withRows(EMPTY, genRows(r, c.hashes).map((x) => x.row));
      const b = withRows(EMPTY, genRows(r, c.hashes).map((x) => x.row));
      const s = state('saving', c.files);
      expect(letters(s, b, c.on), `seed ${seed} two records`).toEqual(letters(s, a, c.on));
      const out = await uploadSave(s, a, NOW, c.on, io(c.on, c.failing), PERSON);
      if (!out.ok) throw new Error(out.reason);
      expect(letters(s, out.commit(a).file, c.on), `seed ${seed} after commit`).toEqual(letters(s, a, c.on));
    }
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
