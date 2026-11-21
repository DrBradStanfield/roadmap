/**
 * PR 0 of the upload matrix (docs/drafts/upload-matrix.md section 4, ruling d1; US-13 AC24): the
 * dated previous column's day (`columnDays`, `needsColumnDay`) lands inert. Over 800 seeded uploads, on
 * both platforms, with no `columnDays` set, `uploadReview`,
 * `uploadView` and `uploadSavePlan` answer exactly what main answered before PR 0, but for one class of seed
 * named below. The golden file (__fixtures__/upload-pr0-golden.json) holds, per seed, the SHA-256 of that
 * answer as main (5c31aa5d1) computed it, unchanged since; run with UPDATE_PR0_GOLDEN=1 on main's code to
 * write it again. The new fields on each lab file (`needsColumnDay` false, `waits` empty, `days`) are
 * checked, then left out, before the hash. Every seed is compared.
 *
 * US-14 AC11 (Brad 2026-11-21) changes, on purpose, exactly the seeds with a cloud and a read lab report
 * with nothing ticked that is not waiting for a day and in which the read found something: Save now keeps
 * that report's original alone (`labArchives`, `counts.originals`, the Save label). Those seeds no longer
 * answer as main did; the test names them by that rule from the inputs alone and asserts the changed set is
 * exactly it, so every other seed still answers as main. (`outcome.archived` is not hashed here: the done
 * phase's outcome is the seed's own.) Synthetic values only.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UNDATED_PREVIOUS, type AdditionalLabValue, type ExtractedValue, type UnifiedExtractionResult } from './lab-extraction';
import { bulkAppendValues, type BulkRow } from './record-edits';
import { createEmptyFile, type RoadmapFile } from './roadmap-file';
import { NO_CHOICES, type FileChoices } from './upload-choices';
import type { UploadFile, UploadState } from './upload-flow';
import { labReadFound, uploadSavePlan } from './upload-plan';
import { uploadReview } from './upload-review';
import { uploadView } from './upload-view';

const GOLDEN = join(__dirname, '__fixtures__', 'upload-pr0-golden.json');
const SEEDS = 800;
const NOW = '2026-11-02T00:00:00.000Z';
const DAY = '2026-11-01';
const PAST = '2026-10-01';
const COLUMN = '2026-09-15';
const FUTURE = '2026-12-01';
/** How many seeds the US-14 AC11 rule names (see the header): the rule is the check, this count pins the seeds' spread. */
const AC11_SEEDS = 15;

/** Kept here, not shared: a shared generator that changed would change every seed and the golden with it. */
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

const core = (over: Partial<ExtractedValue>): ExtractedValue => ({ metric: 'ldl', valueSI: 3.1, displayValue: 3.1, displayUnit: 'mmol/L', displaySystem: 'si', confidence: 'high', ...over });
const extra = (over: Partial<AdditionalLabValue>): AdditionalLabValue => ({ name: 'Ferritin', value: 80, unit: 'µg/L', ...over });

/** Values on no day, a past day, a dated previous column, the undated previous column, or a day to come. */
function genValues(r: () => number): Pick<UnifiedExtractionResult, 'values' | 'additionalValues'> {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const own = () => pick([undefined, undefined, PAST, COLUMN, UNDATED_PREVIOUS, FUTURE] as const);
  const at = () => { const d = own(); return d ? { recordedAt: d } : {}; };
  const values: ExtractedValue[] = [];
  const additionalValues: AdditionalLabValue[] = [];
  for (let i = 0, n = 1 + Math.floor(r() * 4); i < n; i++) {
    const kind = pick(['ldl', 'hba1c', 'ldlHigh', 'ldlQ', 'ferritin', 'refused', 'bp'] as const);
    if (kind === 'ldl') values.push(core({ valueSI: pick([3.1, 2.4]), displayValue: 3.1, ...at() }));
    if (kind === 'hba1c') values.push(core({ metric: 'hba1c', valueSI: pick([40, 52]), displayValue: 40, displayUnit: 'mmol/mol', ...at() }));
    if (kind === 'ldlHigh') values.push(core({ valueSI: 500, displayValue: 500, ...at() }));
    if (kind === 'ldlQ') values.push(core({ question: 'Is this LDL?', confidence: 'medium', ...at() }));
    if (kind === 'ferritin') additionalValues.push(extra({ value: pick([80, 95]), ...at() }));
    if (kind === 'refused') additionalValues.push(extra({ unit: 'zzz', ...at() }));
    if (kind === 'bp') { const d = at(); values.push(core({ metric: 'systolic_bp', valueSI: 120, displayValue: 120, displayUnit: 'mmHg', ...d }), core({ metric: 'diastolic_bp', valueSI: 80, displayValue: 80, displayUnit: 'mmHg', ...d })); }
  }
  return { values, additionalValues };
}

function genExtraction(r: () => number): UnifiedExtractionResult {
  const kind = r();
  if (kind < 0.6) {
    const reportDate = r() < 0.6 ? DAY : r() < 0.7 ? null : '2026-11';
    return { classification: 'lab_report', reportDate, ...genValues(r), unrecognized: [], document: null };
  }
  const classification = r() < 0.5 ? 'clinic_letter' : 'scan_result';
  const metadata = r() < 0.4 ? { screeningType: r() < 0.5 ? 'colorectal' : 'breast' } : {};
  const documentDate = r() < 0.6 ? '2026-10-20' : r() < 0.5 ? '2026-06' : null;
  // A letter that prints values: filed as a letter alone on both platforms.
  const values = r() < 0.4 ? genValues(r) : { values: [], additionalValues: [] };
  return { classification, reportDate: null, ...values, unrecognized: [], document: { classification, title: 'Synthetic letter', documentDate, contentMarkdown: '## Plan', metadata } };
}

function genRecord(r: () => number): RoadmapFile {
  const rows: BulkRow[] = [];
  const add = (p: number, row: BulkRow) => { if (r() < p) rows.push(row); };
  add(0.3, { kind: 'measurement', metricType: 'ldl', value: 3.1, recordedAt: DAY, source: 'manual' });
  add(0.3, { kind: 'measurement', metricType: 'ldl', value: 2.0, recordedAt: PAST, source: 'manual' });
  add(0.25, { kind: 'measurement', metricType: 'hba1c', value: 52, recordedAt: COLUMN, source: 'manual' });
  add(0.25, { kind: 'lab', metricName: 'Ferritin', value: 80, unit: 'µg/L', referenceLow: null, referenceHigh: null, recordedAt: PAST, source: 'manual' });
  const file = bulkAppendValues(createEmptyFile({ deviceId: 'test', now: NOW }), rows, NOW).file;
  return r() < 0.2 ? { ...file, documents: [{ id: 'held-doc', title: 'Held letter', type: 'clinic_letter', date: '2026-01-01', fileRef: '', contentHash: 'h-f1', mimeType: '', extractedText: '', addedAt: NOW, metadata: {}, sourceFileName: 'held.pdf' }] } : file;
}

/** The web's and the iPhone's choices today: ticks, the days, Replace, edits, a document's fixes. Never `columnDays`. */
function genChoices(r: () => number, x: UnifiedExtractionResult, record: RoadmapFile): FileChoices {
  const refs = [...(x.values ?? []).map((_, i) => `v${i}`), ...(x.additionalValues ?? []).map((_, i) => `a${i}`)];
  const held = [...record.measurements, ...record.labValues].map((row) => row.id);
  const c: FileChoices = { ...NO_CHOICES, ticks: {}, replace: {}, edits: {}, document: {} };
  for (const ref of refs) {
    if (r() < 0.2) c.ticks[ref] = r() < 0.3;
    if (held.length && r() < 0.15) c.replace[ref] = held[Math.floor(r() * held.length)];
    if (r() < 0.1) c.edits[ref] = ref[0] === 'v' ? 2.7 : 90;
  }
  if (r() < 0.3) c.testDay = r() < 0.8 ? PAST : 'partial';
  if (r() < 0.3) c.previousDay = r() < 0.8 ? '2026-08-01' : FUTURE;
  if (x.document && r() < 0.2) c.document = r() < 0.5 ? { title: 'Fixed' } : { date: r() < 0.5 ? null : '2026-10-21' };
  return c;
}

interface Case { state: UploadState; record: RoadmapFile; cloud: boolean }

function genCase(seed: number): Case {
  const r = mulberry32(seed);
  const platform = r() < 0.5 ? 'web' : 'phone';
  const record = genRecord(r);
  const files: UploadFile[] = Array.from({ length: 1 + Math.floor(r() * 3) }, (_, i) => {
    const id = `f${i}`;
    const base = { id, name: `${id}.pdf`, bytes: 1, hash: `h-${id}`, pages: { count: 1, truncated: false } };
    if (r() < 0.1) return { ...base, status: { s: 'known', as: 'document', archiveOnly: true } };
    if (r() < 0.05) return { ...base, status: { s: 'failed', reason: 'busy', attempt: 1 } };
    const extraction = genExtraction(r);
    return { ...base, status: { s: 'read', extraction, choices: genChoices(r, extraction, record) } };
  });
  const pick = { platform, run: 1, files, started: NOW, firstRead: NOW } as const;
  const phase = r();
  const state: UploadState = phase < 0.7 ? { phase: 'open', ...pick }
    : phase < 0.8 ? { phase: 'saveFailed', ...pick, attempt: 1, message: 'Failed' }
      : phase < 0.9 ? { phase: 'saving', ...pick, attempt: 1 }
        : { phase: 'done', ...pick, outcome: { values: 1, documents: 0, archived: 0 } };
  return { state, record, cloud: r() < 0.5 };
}

/** Maps as entries, row ids (random per run) by first appearance. */
function canonical(value: unknown): string {
  const ids = new Map<string, string>();
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  return JSON.stringify(value, (_, v) => {
    if (v instanceof Map) return [...v.entries()];
    if (typeof v === 'string' && uuid.test(v)) {
      const m = v.match(uuid)![0];
      if (!ids.has(m)) ids.set(m, `id${ids.size}`);
      return v.replace(m, ids.get(m)!);
    }
    return v;
  });
}

/** Main's answer for a case: the new fields checked (no column waits), then left out. `days` is the review's
 *  own record of each value's day, which main kept inside the review; its effect is in the plan and view. */
function answer(c: Case): string {
  const review = uploadReview(c.state, c.record, NOW);
  const plan = uploadSavePlan(c.state, c.record, NOW, review, c.cloud);
  const view = uploadView(c.state, c.record, NOW, review, c.cloud);
  const labFiles = review.labFiles.map((l) => {
    const { needsColumnDay, waits, days: _days, ...old } = l as typeof l & { needsColumnDay?: boolean; waits?: readonly string[]; days?: unknown };
    expect(needsColumnDay ?? false).toBe(false);
    expect(waits ?? []).toEqual([]);
    return old;
  });
  return canonical({ review: { ...review, labFiles }, plan, view });
}

const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 24);

describe('US-13 AC24: PR 0 is inert with none of its choices set', () => {
  it(`uploadReview, uploadView and uploadSavePlan answer as main did, for ${SEEDS} seeds on both platforms`, () => {
    const now: Record<string, string> = {};
    for (let seed = 1; seed <= SEEDS; seed++) now[seed] = hash(answer(genCase(seed)));
    if (process.env.UPDATE_PR0_GOLDEN) writeFileSync(GOLDEN, `${JSON.stringify(now, null, 0)}\n`);
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, string>;
    expect(Object.keys(golden)).toHaveLength(SEEDS);
    // US-14 AC11: the seeds it changes, named from the inputs, never from the plan: a cloud, and a read lab report
    // not waiting for a day, with nothing ticked and something found. Every other seed answers as main did.
    const keepsAlone = (c: Case) => c.cloud && uploadReview(c.state, c.record, NOW).labFiles.some((l) => {
      const f = 'files' in c.state ? c.state.files.find((x) => x.id === l.fileId) : undefined;
      return !l.ticked.length && !l.needsDay && f?.status.s === 'read' && labReadFound(f.status.extraction);
    });
    const changed = Object.keys(now).filter((seed) => golden[seed] !== now[seed]);
    expect(changed).toEqual(Object.keys(now).filter((seed) => keepsAlone(genCase(Number(seed)))));
    expect(changed).toHaveLength(AC11_SEEDS);
    // Both platforms and every phase are covered.
    const cases = Object.keys(now).map((seed) => genCase(Number(seed)).state);
    expect(new Set(cases.map((s) => ('platform' in s ? s.platform : '')))).toEqual(new Set(['web', 'phone']));
    expect(new Set(cases.map((s) => s.phase))).toEqual(new Set(['open', 'saveFailed', 'saving', 'done']));
  });
});
