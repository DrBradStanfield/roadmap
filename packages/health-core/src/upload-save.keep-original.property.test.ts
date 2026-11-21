/**
 * US-14 AC11, generated: what one Save keeps and counts, judged by an oracle that reads only the records before and
 * after, the cloud's writes, the outcome and the generator's own inputs (which bytes each test name came from), never
 * the plan's lists. Picks mix ticked, unticked, partly ticked and refused-only lab copies and letter copies over shared
 * hashes; records hold a value the pick duplicates, conflicts with, or shares a day with; the press may carry a reviewed
 * page; another writer may change the record between the originals and the commit; the caller may not hold an original
 * or the cloud may refuse it. Each property names the mutation it was seen to fail against. Synthetic values only.
 */
import { describe, expect, it } from 'vitest';
import { DAY, EMPTY, extra, NOW } from './import-review.test-helpers';
import { documentRow, documentView, isLabArchiveDocument, labArchiveFields, listedRows } from './document-rows';
import type { UnifiedExtractionResult } from './lab-extraction';
import { bulkAppendValues, type BulkRow } from './record-edits';
import type { RoadmapFile } from './roadmap-file';
import { NO_CHOICES, type FileChoices } from './upload-choices';
import type { UploadFile, UploadState } from './upload-flow';
import { planIsEmpty, uploadSavePlan } from './upload-plan';
import { reviewedWrites, uploadReview } from './upload-review';
import { uploadSave, type UploadSaveIO } from './upload-save';

const SEEDS = 300;
/** Each hash's own tests, so a new lab row names the bytes it came from (the oracle's only link from a value to a file). */
const TESTS: Record<string, Array<{ name: string; value: number; unit: string }>> = {
  'h-1': [{ name: 'Ferritin', value: 80, unit: 'µg/L' }, { name: 'Vitamin D', value: 70, unit: 'nmol/L' }],
  'h-2': [{ name: 'Vitamin B12', value: 400, unit: 'pmol/L' }, { name: 'Folate', value: 20, unit: 'nmol/L' }],
  'h-3': [{ name: 'Magnesium', value: 0.9, unit: 'mmol/L' }, { name: 'Zinc', value: 12, unit: 'µmol/L' }],
};
const hashOfTest = new Map(Object.entries(TESTS).flatMap(([h, ts]) => ts.map((t) => [t.name, h] as const)));

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Case { s: UploadState; record: RoadmapFile; cloud: boolean; notHeld: string[]; refused: string[]; reviewed: boolean; meanwhile: boolean }

function genCase(seed: number): Case {
  const r = rng(seed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const files: UploadFile[] = Array.from({ length: 1 + Math.floor(r() * 4) }, (_, k) => {
    const hash = pick(Object.keys(TESTS));
    const id = `f${k}`;
    const base = { id, name: `${id}.pdf`, bytes: 1, hash, pages: { count: 1, truncated: false } };
    if (r() < 0.2) {
      const document = { classification: 'clinic_letter' as const, title: `Letter ${hash}`, documentDate: '2026-10-20', contentMarkdown: '## Plan', metadata: {} };
      return { ...base, status: { s: 'read', extraction: { classification: 'clinic_letter', reportDate: null, values: [], additionalValues: [], unrecognized: [], document }, choices: NO_CHOICES } };
    }
    const refusedOnly = r() < 0.1;
    const extraction: UnifiedExtractionResult = {
      classification: 'lab_report', reportDate: DAY, values: [], unrecognized: [], document: null,
      additionalValues: refusedOnly ? [extra({ name: TESTS[hash][0].name, unit: 'zzz' })] : TESTS[hash].map((t) => extra(t)),
    };
    const ticks: FileChoices['ticks'] = pick<FileChoices['ticks']>([{}, { a0: false, a1: false }, { a0: false }, { a1: false }]);
    return { ...base, status: { s: 'read', extraction, choices: { ...NO_CHOICES, ticks } } };
  });
  const held: BulkRow[] = [];
  const lab = (name: string, value: number, unit: string): BulkRow => ({ kind: 'lab', metricName: name, value, unit, referenceLow: null, referenceHigh: null, recordedAt: DAY, source: 'manual' });
  if (r() < 0.3) held.push(lab('Ferritin', 80, 'µg/L')); // a duplicate of h-1's value
  if (r() < 0.3) held.push(lab('Vitamin B12', 450, 'pmol/L')); // a conflict with h-2's
  if (r() < 0.3) held.push(lab('Calcium', 2.4, 'mmol/L')); // another value on the report's day
  const record = held.length ? bulkAppendValues(EMPTY, held, NOW).file : EMPTY;
  const ids = files.map((f) => f.id);
  return {
    s: { phase: 'open', platform: pick(['web', 'phone'] as const), run: 1, files, started: NOW, firstRead: NOW },
    record, cloud: r() < 0.7,
    notHeld: ids.filter(() => r() < 0.1), refused: ids.filter(() => r() < 0.1),
    reviewed: r() < 0.5, meanwhile: r() < 0.3,
  };
}

/** Another writer, between the originals and the commit: every held value deleted, a Vitamin D on the day, and
 *  h-1's original filed by another device (a lab archive row that stores it). */
const otherDevice = documentRow({ ...labArchiveFields('other.pdf', DAY), sourceFileName: 'other.pdf' }, { id: 'other-device', contentHash: 'h-1', mimeType: 'application/pdf', addedAt: NOW });
const meanwhile = (f: RoadmapFile) => {
  const next = bulkAppendValues({ ...f, labValues: f.labValues.map((v) => ({ ...v, status: 'entered-in-error' as const })) },
    [{ kind: 'lab', metricName: 'Vitamin D', value: 55, unit: 'nmol/L', referenceLow: null, referenceHigh: null, recordedAt: DAY, source: 'manual' }], NOW).file;
  return { ...next, documents: [...next.documents, { ...otherDevice, fileRef: 'Lab results/other.pdf' }] };
};

async function run(c: Case, record: RoadmapFile, opts: { reviewed: boolean; meanwhile: boolean }) {
  const review = uploadReview(c.s, record, NOW);
  const saving: UploadState = { ...(c.s as Extract<UploadState, { phase: 'open' }>), phase: 'saving', attempt: 1, ...(opts.reviewed ? { reviewed: reviewedWrites(review) } : {}) };
  const stored: string[] = [];
  let n = 0;
  const io: UploadSaveIO<string> = {
    holds: (id) => !c.notHeld.includes(id), original: (id) => `bytes of ${id}`, mimeType: () => 'application/pdf',
    write: async (ref, _b, id) => { if (c.refused.includes(id)) throw new Error('refused'); stored.push(ref); },
    now: () => NOW, newId: () => `doc-${n++}`,
  };
  const plan = uploadSavePlan(c.s, record, NOW, review, c.cloud);
  const out = await uploadSave(saving, record, NOW, c.cloud, io);
  if (!out.ok) throw new Error(out.reason);
  const at = opts.meanwhile ? meanwhile(record) : record;
  const { file, outcome } = out.commit(at);
  return { plan, at, file, outcome, stored };
}

const live = (f: RoadmapFile) => f.documents.filter((d) => !d.deleted);
const isArchive = (d: RoadmapFile['documents'][number]) => isLabArchiveDocument(documentView(d));

describe('US-14 AC11: one Save keeps every original or says so, and counts what it wrote', () => {
  it(`holds properties 1-5 over ${SEEDS} seeded picks`, async () => {
    let kept = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const c = genCase(seed);
      const label = `seed ${seed}`;
      const { plan, at, file, outcome, stored } = await run(c, c.record, c);
      const before = c.record;
      // Refs held before this Save wrote anything: the planning record's and any another writer filed meanwhile.
      const beforeRefs = new Set([...before.documents, ...at.documents].map((d) => d.fileRef).filter(Boolean));
      const pickHashes = new Set(('files' in c.s ? c.s.files : []).map((f) => f.hash!));
      const newRows = file.labValues.filter((v) => !at.labValues.some((b) => b.id === v.id));
      const valued = new Set(newRows.map((v) => hashOfTest.get(v.metricName) ?? ''));
      const gained = live(file).filter((d) => d.fileRef && !beforeRefs.has(d.fileRef));

      // 1. Kept (mutations: `unstored = docs.unstored`, main's count; `storedHashes(record)` for `storedHashes(out)`,
      //    judging "already stored" before the writes, which another device's copy meanwhile shows; main's
      //    `!lab.ticked.length -> continue` in upload-plan.ts): with a cloud, every hash in the pick has a live row with an
      //    original after Save, or is counted unstored. Never neither.
      if (c.cloud) {
        const missing = [...pickHashes].filter((h) => !live(file).some((d) => d.contentHash === h && d.fileRef));
        expect(missing.length, `${label}: 1`).toBe(outcome.unstored);
      } else {
        expect(gained, `${label}: 1 off cloud`).toEqual([]);
      }

      // 2. Archived (mutation: drop `!valued.has(...)` from `archived` in upload-save.ts): the hashes that gained an
      //    original in this Save on a lab archive row and whose bytes wrote no value now.
      const archived = new Set(gained.filter((d) => isArchive(d) && !valued.has(d.contentHash ?? '')).map((d) => d.contentHash));
      expect(outcome.archived, `${label}: 2`).toBe(archived.size);
      kept += archived.size;

      // 3. Lists (mutation: rows grouped by file id, not by bytes: `rowsOf = labRowsByFile(planned, rowFiles)`): every
      //    listed id is a lab row of the record, and every new lab row is listed on the archive row of its bytes. Bytes a
      //    letter copy files are left out: a letter claims its bytes ahead of a lab copy, as on main (no archive row).
      const listed = live(file).filter(isArchive).flatMap((d) => (listedRows(d) ?? []).map((id) => [d.contentHash, id] as const));
      const asLetter = new Set(live(file).filter((d) => !isArchive(d)).map((d) => d.contentHash));
      for (const [, id] of listed) expect(file.labValues.some((v) => v.id === id), `${label}: 3 listed`).toBe(true);
      for (const v of newRows.filter((x) => !asLetter.has(hashOfTest.get(x.metricName) ?? ''))) {
        expect(listed.some(([h, id]) => h === hashOfTest.get(v.metricName) && id === v.id), `${label}: 3 new`).toBe(true);
      }

      if (c.reviewed || c.meanwhile) continue;
      // 4. Label truth on an unchanged record with no reviewed page (mutation: an unticked copy pushed straight to
      //    `labArchives`, claiming nothing, in upload-plan.ts): the originals and documents the label counts are the
      //    originals stored plus those counted unstored; Save writes nothing exactly when the plan is empty. With a cloud
      //    only: off it, a report whose ticked values are all refused files a hash-only row under an empty plan, as on main.
      if (c.cloud) {
        expect(plan.counts.originals + plan.counts.documents, `${label}: 4 count`).toBe(stored.length + outcome.unstored);
        expect(planIsEmpty(plan), `${label}: 4 empty`).toBe(file === before);
      }

      // 5. Idempotence (mutation: the plan's stored skip also skipping hash-only rows, so an original that failed is
      //    never offered again): a second Save on the
      //    result writes nothing; an original that cannot be stored is counted again, never a new row.
      const again = await run(c, file, { reviewed: false, meanwhile: false });
      expect(again.file, `${label}: 5 same file`).toBe(file);
      expect(again.stored, `${label}: 5 no write`).toEqual([]);
      const unstorable = c.cloud ? [...pickHashes].filter((h) => !live(file).some((d) => d.contentHash === h && d.fileRef)).length : 0;
      expect(again.outcome, `${label}: 5 counts`).toEqual({ values: 0, documents: 0, archived: 0, unstored: unstorable });
    }
    expect(kept, 'the picks keep some originals alone').toBeGreaterThan(20);
  });
});
