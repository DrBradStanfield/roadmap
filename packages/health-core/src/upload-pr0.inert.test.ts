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
 * US-14 AC11 (Brad 2026-11-21) changes, on purpose, exactly the seeds with a cloud and a read lab report with
 * nothing ticked in which the read found something, dated or not: Save now keeps that report's original alone.
 * The test names those reports from the inputs alone, asserts the changed seeds are exactly the seeds holding one,
 * and asserts how each changed: one new `labArchives` entry per such report (its fileId, name and the review's day),
 * `counts.originals` up by as many, and the Save button as the label rule gives it; with those three undone, every
 * changed seed hashes to main's answer again. (`outcome.archived` is not hashed here: the done phase's outcome is
 * the seed's own.)
 *
 * Web list PR 1b (owner ruling 2026-11-21) changes, on purpose, one more class: on the web a value not sent is
 * previewed with its edit. The test names its seeds (a web read lab report holding an edit on a value the review does
 * not send, whose answer differs once that preview is undone), asserts the changed seeds are exactly those and AC11's,
 * and that with the preview undone each hashes to main's answer. Every phone seed, edits included, answers as main did:
 * the phone's preview never reads an edit. Unreachable today: the web never calls the engine's view yet.
 *
 * Owner ruling on PR 1957 (2026-11-22) changes, on purpose, one more class, on both platforms: a read letter starts from
 * the reader's answer in the upload state, never from a row the record holds for its bytes. The test names its seeds from
 * the inputs alone (the record holds the metadata-only letter row `held-doc` for `h-f1`, and f1 is a read letter), asserts
 * the changed seeds are exactly those and the classes above, and that with the held row's title and date put back where
 * the person made no fix (in the plan and in the view's documents row) each hashes to main's answer. Synthetic values only.
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
import { labReadFound, planIsEmpty, uploadSavePlan, type UploadSavePlan } from './upload-plan';
import { uploadReview } from './upload-review';
import { FILE_NOTICE_TEXT, UPLOAD_TEXT } from './upload-text';
import { documentDateLine, uploadView } from './upload-view';

const GOLDEN = join(__dirname, '__fixtures__', 'upload-pr0-golden.json');
const SEEDS = 800;
const NOW = '2026-11-02T00:00:00.000Z';
const DAY = '2026-11-01';
const PAST = '2026-10-01';
const COLUMN = '2026-09-15';
const FUTURE = '2026-12-01';
/** How many seeds the US-14 AC11 rule names (see the header): the rule is the check, this count pins the seeds' spread. */
const AC11_SEEDS = 15;
/** How many seeds the web list PR 1b rule names (`editPreviewCandidate`): 19, all on the web. */
const EDIT_PREVIEW_SEEDS = 19;
/** How many seeds the read-letter ruling names (`heldLetter`): the spread, on both platforms. */
const HELD_LETTER_SEEDS = 35;

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

/** The Save label as main's rule gave it, in every phase. */
const mainLabel = ({ values, documents, originals }: UploadSavePlan['counts']) =>
  (values || documents || !originals ? UPLOAD_TEXT.saveBoth(values, documents) : UPLOAD_TEXT.saveOriginals(originals));

/** Main's answer for a case: the new fields checked (no column waits), then left out. `days` is the review's
 *  own record of each value's day, which main kept inside the review; its effect is in the plan and view. */
function parts(c: Case, previewEdits = true) {
  // `previewEdits` false: the review as main judged it, a value not sent previewed on its number read (`reviewFlags`,
  // which turns the edit's preview on for the web only; the review reads the platform for nothing else).
  const review = uploadReview(previewEdits ? c.state : { ...c.state, platform: 'phone' }, c.record, NOW);
  const plan = uploadSavePlan(c.state, c.record, NOW, review, c.cloud);
  const drawn = uploadView(c.state, c.record, NOW, review, c.cloud);
  // US-12 AC6 (2026-11-23): Save says "Saving..." while it saves, on both platforms, on purpose. Undone here for every
  // saving seed, after checking it: the label main drew then, the plan's words.
  if (c.state.phase === 'saving') expect(drawn.save.label).toBe(UPLOAD_TEXT.saving);
  const view = c.state.phase === 'saving' ? { ...drawn, save: { ...drawn.save, label: mainLabel(plan.counts) } } : drawn;
  const labFiles = review.labFiles.map((l) => {
    const { needsColumnDay, waits, days: _days, ...old } = l as typeof l & { needsColumnDay?: boolean; waits?: readonly string[]; days?: unknown };
    expect(needsColumnDay ?? false).toBe(false);
    expect(waits ?? []).toEqual([]);
    return old;
  });
  return { review: { ...review, labFiles }, plan, view: mainView(view, c.state) };
}
const answer = (c: Case): string => canonical(parts(c));

/**
 * US-14 AC11's reports in a case, from the inputs alone: with a cloud, a read lab report with nothing ticked in
 * which the read found something (`labReadFound`), dated or undated (nothing ticked never waits for a day). The
 * plan's other conditions are not tested here because this generator cannot reach them, and the test asserts so:
 * every file has a hash; none is a photo or scan (`original` is never set); no record row stores an original (the
 * one document, `held-doc`, has `fileRef ''`); and every file's bytes are its own (`h-f<i>`), so no other copy in
 * the pick can claim them.
 */
function keptAlone(c: Case): Array<{ fileId: string; sourceFileName: string; reportDate: string | null }> {
  const files = 'files' in c.state ? c.state.files : [];
  expect(files.every((f) => f.hash && f.original === undefined)).toBe(true);
  expect(new Set(files.map((f) => f.hash)).size).toBe(files.length);
  expect(c.record.documents.every((d) => !d.fileRef)).toBe(true);
  if (!c.cloud) return [];
  return uploadReview(c.state, c.record, NOW).labFiles.flatMap((l) => {
    const f = files.find((x) => x.id === l.fileId);
    return !l.ticked.length && f?.status.s === 'read' && labReadFound(f.status.extraction) ? [{ fileId: l.fileId, sourceFileName: f.name, reportDate: l.day }] : [];
  });
}

/**
 * Web list PR 1b (owner ruling 2026-11-21): on the web a value not sent is previewed with its edit (`reviewFlags`). The
 * seeds it may change, from the case: web, and a read lab report holding an edit on a value the review does not send.
 * Unreachable today: the web's page never calls the engine's view yet (UploadModal draws the web's own review).
 */
function editPreviewCandidate(c: Case): boolean {
  if (c.state.platform !== 'web' || !('files' in c.state)) return false;
  const files = c.state.files;
  const review = uploadReview(c.state, c.record, NOW);
  return review.classification.values.some((v) => {
    const f = files.find((x) => x.id === review.labFiles[v.file].fileId);
    return !v.sent && f?.status.s === 'read' && f.status.choices.edits[v.ref] !== undefined;
  });
}

/** The answer with AC11's change undone: its entries out of `labArchives`, `originals` down, the Save button as main's rule gave it. */
function asMain(c: Case, kept: ReturnType<typeof keptAlone>): string {
  const { review, plan, view } = parts(c);
  const ids = new Set(kept.map((k) => k.fileId));
  const main: UploadSavePlan = { ...plan, labArchives: plan.labArchives.filter((a) => !ids.has(a.fileId)), counts: { ...plan.counts, originals: plan.counts.originals - kept.length } };
  const label = mainLabel(main.counts);
  // Only an open page asks the plan whether Save has anything to do; nothing else in the view reads these fields.
  const empty = c.state.phase === 'open' && view.save.why === null && planIsEmpty(main);
  const save = { ...view.save, label, ...(empty ? { enabled: false, why: UPLOAD_TEXT.saveNothing } : {}) };
  return canonical({ review, plan: main, view: { ...view, save } });
}

/** The metadata-only letter row `genRecord` may hold, for `h-f1`: its title and date, as main's plan started from them. */
const HELD_ROW = { title: 'Held letter', date: '2026-01-01' };

/** The read-letter ruling's seeds, from the inputs alone: the record holds `held-doc` and f1 is a read letter. */
function heldLetter(c: Case): UploadFile | null {
  if (!c.record.documents.some((d) => d.id === 'held-doc' && d.contentHash === 'h-f1' && !d.fileRef)) return null;
  const f = 'files' in c.state ? c.state.files.find((x) => x.id === 'f1') : undefined;
  return f?.status.s === 'read' && f.status.extraction.classification !== 'lab_report' && f.status.extraction.document ? f : null;
}

/** The answer with the ruling undone: the letter's title and date as the held row gave them where the person made no
 *  fix, in the plan and in the view's documents row drawn from it. */
function asMainHeld(c: Case, f: UploadFile): string {
  const { review, plan, view } = parts(c);
  const fix = f.status.s === 'read' ? f.status.choices.document : {};
  const undo = <T extends { title: string; documentDate: string | null }>(x: T): T =>
    ({ ...x, ...(fix.title === undefined ? { title: HELD_ROW.title } : {}), ...('date' in fix ? {} : { documentDate: HELD_ROW.date }) });
  const documents = plan.documents.map((d) => (d.fileId === f.id ? { ...d, fields: undo(d.fields) } : d));
  const fields = documents.find((d) => d.fileId === f.id)!.fields;
  const rows = view.documents && view.documents.rows.map((r) => (r.fileId !== f.id ? r : {
    ...r, title: fields.title, date: documentDateLine(fields.documentDate), dateKnown: fields.documentDate !== null, day: fields.documentDate?.slice(0, 10) ?? null,
  }));
  return canonical({ review, plan: { ...plan, documents }, view: { ...view, documents: view.documents && { ...view.documents, rows } } });
}

/**
 * The view as main drew it: the web list's new keys (PR 1a) deleted, and nothing else touched. Each row's `saves`, each
 * day section's `key`, and Save's `blockers`. No `unitOf` is passed, so no row has `shown`.
 *
 * PR 1974's one placement rule for a file's reason (US-12 AC9) moves, on purpose, a read file's empty-read line: main put
 * it both in its Files row and in `notices`; now it sits in one of them, by what the screen draws. Undone here for every
 * seed: each Files row's `notFullyRead` deleted, and the line put back in both places. No seed is cut short, so the
 * empty-read lines are the only soft reasons. Before that, each line is checked to sit in exactly one place: in the
 * notices beside a row reading "Read" on the iPhone's review, else in the row with no notice.
 */
const MAIN_VIEW_OMITS = { row: ['saves'], section: ['key'], save: ['blockers'] } as const;
function mainView(view: ReturnType<typeof uploadView>, s: UploadState) {
  const omit = <T extends object>(x: T, keys: readonly string[]) => Object.fromEntries(Object.entries(x).filter(([k]) => !keys.includes(k)));
  const row = (r: object) => omit(r, MAIN_VIEW_OMITS.row);
  const empty: readonly string[] = [FILE_NOTICE_TEXT.noValues, FILE_NOTICE_TEXT.documentOnly];
  if (s.platform === 'phone' && s.phase !== 'done') {
    expect(view.files.rows.filter((r) => empty.includes(r.status))).toEqual([]);
    for (const n of view.notices) expect(view.files.rows.find((r) => r.fileId === n.fileId)?.status).toBe(UPLOAD_TEXT.statusRead);
    expect(new Set(view.notices.map((n) => n.fileId)).size).toBe(view.notices.length);
  } else {
    expect(view.notices).toEqual([]);
  }
  const soft = new Map([...view.files.rows.filter((r) => empty.includes(r.status)).map((r) => [r.fileId, r.status] as const),
    ...view.notices.map((n) => [n.fileId, n.line] as const)]);
  return {
    ...view,
    files: { ...view.files, rows: view.files.rows.map(({ notFullyRead: _, ...r }) => ({ ...r, status: soft.get(r.fileId) ?? r.status })) },
    notices: view.files.rows.filter((r) => soft.has(r.fileId)).map((r) => ({ fileId: r.fileId, name: r.name, line: soft.get(r.fileId)! })),
    sections: view.sections.map((x) => omit('rows' in x && x.kind === 'unsure' ? { ...x, rows: x.rows.map(row) } : x, MAIN_VIEW_OMITS.section)),
    sure: view.sure && { ...view.sure, rows: view.sure.rows.map(row) },
    save: omit(view.save, MAIN_VIEW_OMITS.save),
  };
}

const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 24);

describe('US-13 AC24: PR 0 is inert with none of its choices set', () => {
  it(`uploadReview, uploadView and uploadSavePlan answer as main did, for ${SEEDS} seeds on both platforms`, () => {
    const now: Record<string, string> = {};
    for (let seed = 1; seed <= SEEDS; seed++) now[seed] = hash(answer(genCase(seed)));
    if (process.env.UPDATE_PR0_GOLDEN) writeFileSync(GOLDEN, `${JSON.stringify(now, null, 0)}\n`);
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, string>;
    expect(Object.keys(golden)).toHaveLength(SEEDS);
    // US-14 AC11: the seeds it changes are those holding one of its reports (`keptAlone`). Web list PR 1b: the others it
    // changes are exactly the web seeds holding an edit on a value not sent (`editPreviewCandidate`) whose answer differs
    // once the edit's preview is undone. Every other seed, every phone seed with an edit included, answers as main did.
    const changed = Object.keys(now).filter((seed) => golden[seed] !== now[seed]);
    const ac11 = Object.keys(now).filter((seed) => keptAlone(genCase(Number(seed))).length > 0);
    const previewed = Object.keys(now).filter((seed) => {
      const c = genCase(Number(seed));
      return editPreviewCandidate(c) && hash(canonical(parts(c, false))) !== now[seed];
    });
    const held = Object.keys(now).filter((seed) => heldLetter(genCase(Number(seed))) !== null);
    expect(changed).toEqual(Object.keys(now).filter((seed) => ac11.includes(seed) || previewed.includes(seed) || held.includes(seed)));
    expect(ac11).toHaveLength(AC11_SEEDS);
    expect(previewed.filter((seed) => !ac11.includes(seed))).toHaveLength(EDIT_PREVIEW_SEEDS);
    // The read-letter class shares no seed with the others, so each is undone alone.
    expect(held.filter((seed) => ac11.includes(seed) || previewed.includes(seed))).toEqual([]);
    expect(held).toHaveLength(HELD_LETTER_SEEDS);
    expect(new Set(held.map((seed) => genCase(Number(seed)).state.platform))).toEqual(new Set(['web', 'phone']));
    // And how: with the held row's title and date put back where the person made no fix, each answers as main did.
    for (const seed of held) {
      const c = genCase(Number(seed));
      expect(hash(asMainHeld(c, heldLetter(c)!)), seed).toBe(golden[seed]);
    }
    // And how: with the edit's preview undone, each answers as main did.
    for (const seed of previewed.filter((x) => !ac11.includes(x))) expect(hash(canonical(parts(genCase(Number(seed)), false))), seed).toBe(golden[seed]);
    // And how: each kept report is one new `labArchives` entry, `originals` counts it, the label says so; undone, main's answer.
    for (const seed of ac11) {
      const c = genCase(Number(seed));
      const kept = keptAlone(c);
      const { plan, view } = parts(c);
      expect(plan.labArchives, seed).toEqual(expect.arrayContaining(kept));
      if (!plan.counts.values && !plan.counts.documents) expect(view.save.label, seed).toBe(UPLOAD_TEXT.saveOriginals(plan.counts.originals));
      expect(hash(asMain(c, kept)), seed).toBe(golden[seed]);
    }
    // Both platforms and every phase are covered.
    const cases = Object.keys(now).map((seed) => genCase(Number(seed)).state);
    expect(new Set(cases.map((s) => ('platform' in s ? s.platform : '')))).toEqual(new Set(['web', 'phone']));
    expect(new Set(cases.map((s) => s.phase))).toEqual(new Set(['open', 'saveFailed', 'saving', 'done']));
  });
});
