/**
 * The list view against Save, over seeded random uploads (US-52 AC8c, US-13 AC13, US-12 AC26; the
 * upload-flow.property.test.ts pattern, mulberry32, no dependency). Each sequence picks 1-3 files on
 * the phone, runs the machine's own landings in random order with chosen values between them, then
 * saves through `uploadSave`, sometimes on a record another writer changed. After every step:
 *   P1 every offered value is a row or a not-saved line, once; P2 the rows the view shows ticked and
 *   writable are the rows Save writes; P3 the Save label and the "will be saved" lines count them;
 *   P4 a disabled Save names a blocker the view gives a control for, and that control clears it;
 *   P5 FHIR after commit; P6 no broken string. A failure prints the seed and a minimised event list.
 *   P7 each written row shows what Save writes (its number, unit, day, the value a Replace replaces).
 *   P8 the review's day for each value (`days`, `waits`) is the one worked out from the extraction and the choices alone.
 * The gaps it found (owner rulings 2026-11-20) are pinned, fixed, in upload-view.gaps.test.ts.
 * Synthetic values, names and hashes only.
 */
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { UNDATED_PREVIOUS, type AdditionalLabValue, type ExtractedValue, type UnifiedExtractionResult } from './lab-extraction';
import { bulkRowTarget } from './bulk-row-target';
import { bulkAppendValues, slotKey, slotOfRow, validDay, type BulkRow } from './record-edits';
import { DAY_NOT_HAPPENED, LAB_DAY_REFUSAL } from './lab-series';
import { mergeFiles } from './merge';
import { knownAs, knownIndex } from './upload-known';
import { reportedToCanonical, type MetricType } from './units';
import { PRESSURE_ORDER } from './validation';
import { createEmptyFile, type FileLabValue, type FileMeasurement, type RoadmapFile } from './roadmap-file';
import type { ChoiceChange, FileChoices } from './upload-choices';
import { initialUpload, inFlight, transition, type PickedFile, type UploadEvent, type UploadState } from './upload-flow';
import { uploadSavePlan } from './upload-plan';
import { lostReplaces, reviewedWrites, uploadReview, type UploadReview } from './upload-review';
import { requestFlags, type UploadPlatform } from './upload-rules';
import { uploadSave, type UploadSaveIO } from './upload-save';
import { uploadView, type UploadView, type ValueRow } from './upload-view';
import { FIX_ERRORS_TEXT, UPLOAD_TEXT } from './upload-text';
import { IMPORT_REVIEW_TEXT, importRow, isOfferedRef, offeredValues, valueAt } from './import-review';

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

const NOW = '2026-11-02T00:00:00.000Z';
const DAY = '2026-11-01';
const PAST = '2026-10-01';
const PICKED_DAY = '2026-10-20';
const FUTURE = '2026-12-01';
/** A previous column's day before every report and test day the run picks. */
const EARLY = '2026-09-01';
/** A second past day a web report prints, as a dated previous column (US-13 AC24). */
const COLUMN = '2026-09-15';
/** A misread report date that has not happened: the only way the server keeps a future own day (lab-extraction.ts `ownDay`: own < report). */
const REPORT_FUTURE = '2026-12-15';

// --- setup: what the reads answer and what the record holds ---------------------------------

const core = (over: Partial<ExtractedValue>): ExtractedValue => ({ metric: 'ldl', valueSI: 3.1, displayValue: 3.1, displayUnit: 'mmol/L', displaySystem: 'si', confidence: 'high', ...over });
const extra = (over: Partial<AdditionalLabValue>): AdditionalLabValue => ({ name: 'Ferritin', value: 80, unit: 'µg/L', ...over });

/** `failWrites`: files whose original the cloud refuses (an unstored original). `platform`: the device the run is on. */
interface Setup { extractions: Record<string, UnifiedExtractionResult>; record: RoadmapFile; cloud: boolean; failWrites: string[]; platform: UploadPlatform }

/** One lab report: core values (ldl, hba1c) and labs from a small pool, each on no day, a past day or (rarely) a future one;
 *  where the platform asks the server for it (`requestFlags` undatedPrev: the web), sometimes the undated previous column,
 *  and some values on a second past day (`COLUMN`), a dated previous column the web's review can move (US-13 AC24). */
function genLab(r: () => number, platform: UploadPlatform): UnifiedExtractionResult {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const coin = (p: number) => r() < p;
  const reportDate = coin(0.65) ? DAY : coin(0.9) ? null : REPORT_FUTURE;
  // The server keeps an own day only before the report's full day (lab-extraction.ts `ownDay`): none on an undated
  // report, and a future one only before a future report date.
  const undatedPrev = requestFlags(platform).undatedPrev;
  const past = () => (undatedPrev && coin(0.4) ? COLUMN : PAST);
  const own = () => (undatedPrev && coin(0.15) ? UNDATED_PREVIOUS : reportDate === null || coin(0.6) ? undefined : reportDate === REPORT_FUTURE && coin(0.5) ? FUTURE : past());
  const values: ExtractedValue[] = [];
  const additionalValues: AdditionalLabValue[] = [];
  const n = 1 + Math.floor(r() * 4);
  for (let i = 0; i < n; i++) {
    const kind = pick(['ldl', 'hba1c', 'ldlQ', 'ldlGuess', 'ldlHigh', 'ferritin', 'refusedAlone', 'bp', 'ldlLimit', 'ldlAsLab', 'ldlMgdl'] as const);
    const recordedAt = own();
    const day = recordedAt ? { recordedAt } : {};
    const ldl = pick([3.1, 2.4]);
    if (kind === 'ldl') values.push(core({ valueSI: ldl, displayValue: ldl, ...day, ...(coin(0.2) ? { confidence: 'medium' as const } : {}) }));
    const a1c = pick([40, 52]);
    if (kind === 'hba1c') values.push(core({ metric: 'hba1c', valueSI: a1c, displayValue: a1c, displayUnit: 'mmol/mol', ...day }));
    if (kind === 'ldlQ') values.push(core({ valueSI: 3.1, question: 'Is this LDL?', ...day }));
    if (kind === 'ldlGuess') values.push(core({ valueSI: 2.4, displayValue: 2.4, unitGuessed: true, ...day }));
    if (kind === 'ldlHigh') values.push(core({ valueSI: 500, displayValue: 500, ...day }));
    if (kind === 'ferritin') additionalValues.push(extra({ value: pick([80, 95]), ...day }));
    if (kind === 'refusedAlone') additionalValues.push(extra({ name: 'Ferritin', unit: 'zzz', ...day }));
    // A blood pressure pair, sometimes the wrong way up (the write refuses both halves, US-02 AC8).
    if (kind === 'bp') {
      const [sys, dia] = coin(0.3) ? [80, 120] : [120, 80];
      values.push(core({ metric: 'systolic_bp', valueSI: sys, displayValue: sys, displayUnit: 'mmHg', ...day }), core({ metric: 'diastolic_bp', valueSI: dia, displayValue: dia, displayUnit: 'mmHg', ...day }));
    }
    // Printed as a limit ("< 0.6", US-12 AC20).
    if (kind === 'ldlLimit') values.push(core({ valueSI: 0.6, displayValue: 0.6, comparator: '<', ...day }));
    // A lab the write files as a core value (bulk-row-target.ts).
    if (kind === 'ldlAsLab') additionalValues.push(extra({ name: 'LDL Cholesterol', value: 2.9, unit: 'mmol/L', ...day }));
    // Printed in mg/dL: the row shows the printed number, the record stores its SI conversion.
    if (kind === 'ldlMgdl') values.push(core({ valueSI: reportedToCanonical('ldl', 116, 'mg/dL')!.valueSI, displayValue: 116, displayUnit: 'mg/dL', displaySystem: 'conventional', ...day }));
  }
  return {
    classification: 'lab_report', reportDate, values, additionalValues, unrecognized: [], document: null,
    ...(coin(0.2) ? { refusedValues: [{ metric: 'creatinine', value: 80, unit: '', reason: 'no unit' }] } : {}),
  };
}

function genLetter(r: () => number): UnifiedExtractionResult {
  return {
    classification: 'clinic_letter', reportDate: null, values: [], additionalValues: [], unrecognized: [],
    document: { classification: 'clinic_letter', title: 'Synthetic letter', documentDate: r() < 0.7 ? '2026-10-20' : null, contentMarkdown: '## Plan', metadata: {} },
  };
}

const EMPTY = createEmptyFile({ deviceId: 'test', now: NOW });

/** A record holding some of the slots the pool lands on: the same value, a different one, and one row entered in error. */
function genRecord(r: () => number): RoadmapFile {
  const rows: BulkRow[] = [];
  const add = (p: number, row: BulkRow) => { if (r() < p) rows.push(row); };
  add(0.3, { kind: 'measurement', metricType: 'ldl', value: 3.1, recordedAt: DAY, source: 'manual' });
  add(0.3, { kind: 'measurement', metricType: 'hba1c', value: 52, recordedAt: DAY, source: 'manual' });
  add(0.25, { kind: 'measurement', metricType: 'ldl', value: 2.0, recordedAt: PAST, source: 'manual' });
  add(0.25, { kind: 'lab', metricName: 'Ferritin', value: 80, unit: 'µg/L', referenceLow: null, referenceHigh: null, recordedAt: PAST, source: 'manual' });
  add(0.2, { kind: 'measurement', metricType: 'systolic_bp', value: 130, recordedAt: DAY, source: 'manual' });
  add(0.15, { kind: 'measurement', metricType: 'diastolic_bp', value: 140, recordedAt: DAY, source: 'manual' });
  let file = bulkAppendValues(EMPTY, rows, NOW).file;
  // A letter held as a metadata-only row (no original): picking its bytes again is an archive-only known file (US-14 AC4).
  if (r() < 0.25) file = { ...file, documents: [{ id: 'held-doc', title: 'Held letter', type: 'clinic_letter', date: '2026-01-01', fileRef: '', contentHash: `h-f${Math.floor(r() * 3)}`, mimeType: '', extractedText: '', addedAt: NOW, metadata: {}, sourceFileName: 'held.pdf' }] };
  // One row entered in error, its slot left free (a deletion), or corrected (its slot moved to a new row).
  if (r() < 0.4) {
    const err = bulkAppendValues(file, [{ kind: 'measurement', metricType: 'hba1c', value: 45, recordedAt: PAST, source: 'manual' }], NOW).file;
    file = { ...err, labValues: err.labValues.map((l) => (l.recordedAt.startsWith(PAST) && l.metricName === 'hba1c' ? { ...l, status: 'entered-in-error' } : l)) };
  }
  return file;
}

// --- events: the machine's own, plus the record and Save steps the platform runs -------------

type Step =
  | { type: 'event'; e: UploadEvent }
  /** Another writer: these rows appended to the record now; `merge`: on another device's copy of the record as the
   *  upload began, merged in (`mergeFiles`), as a cloud read brings it. */
  | { type: 'record'; rows: BulkRow[]; merge: boolean }
  /** Another writer deletes a held row (entered in error, no correction): a Replace aimed at it is lost. */
  | { type: 'delete'; id: string }
  /** Save tapped on the page drawn before another writer acts (rows appended, or `free`: a held row deleted): the app
   *  sends back the drawn page's `reviewed`. */
  | { type: 'tap'; rows: BulkRow[]; merge: boolean; free: string | null }
  /** One Save as the platform runs it: `uploadSave` on the record, commit on it, or on it after `meanwhile`. */
  | { type: 'save'; ok: boolean; meanwhile: BulkRow[] | null; merge: boolean; free: string | null; when: 'beforeSave' | 'beforeCommit' };

type Row = FileMeasurement | FileLabValue;
const rowsOf = (f: RoadmapFile): Row[] => [...f.measurements, ...f.labValues];
const isActive = (row: Row) => (row.status ?? 'active') === 'active';
const key = (fileId: string, ref: string) => `${fileId}|${ref}`;

/** The rows the view shows ticked and writable: ticked, no error, not out of range, no conflict kept, the report not waiting for its day. */
function shownWritable(view: UploadView, review: UploadReview): Set<string> {
  const waiting = new Set(review.labFiles.filter((f) => f.needsDay).map((f) => f.fileId));
  const out = new Set<string>();
  for (const row of allRows(view)) {
    if (!row.ticked || row.error || row.copy || row.reasons.includes('outOfRange') || waiting.has(row.fileId)) continue;
    if (row.conflict !== null && !row.replacing) continue;
    out.add(key(row.fileId, row.ref));
  }
  return out;
}
const allRows = (view: UploadView): ValueRow[] => [
  ...view.sections.flatMap((s) => (s.kind === 'unsure' ? s.rows : [])),
  ...(view.sure?.rows ?? []),
];
/** The values the review writes, by file and ref (`classification.rows` in order). */
const written = (review: UploadReview) => new Set(review.classification.values.filter((v) => v.sent && v.writes).map((v) => key(review.labFiles[v.file].fileId, v.ref)));

class Failure extends Error { constructor(public prop: string, msg: string) { super(`${prop}: ${msg}`); } }
const fail = (prop: string, msg: string): never => { throw new Failure(prop, msg); };

const BAD_TEXT = /undefined|NaN|\[object|\d{4}-\d{2}-\d{2}T\d{2}:/;
/** P6: every string the view shows; ids, refs, reason keys and section kinds are not shown. */
function checkText(view: UploadView) {
  const walk = (x: unknown, path: string) => {
    if (typeof x === 'string') {
      if (!x.trim() || BAD_TEXT.test(x)) fail('P6', `${path} = ${JSON.stringify(x)}`);
    } else if (Array.isArray(x)) x.forEach((y, i) => walk(y, `${path}[${i}]`));
    else if (x && typeof x === 'object') {
      for (const [k, y] of Object.entries(x)) if (!['fileId', 'ref', 'replaces', 'reasons', 'kind', 'month', 'before'].includes(k) || (k === 'kind' && path.includes('documents'))) walk(y, `${path}.${k}`);
    }
  };
  walk(view, 'view');
}

/** A known gap seen, by name. */
type Note = (gap: string) => void;

/** P1, P2 (same record), P3, P4 on one view. `note`: a known gap seen. */
function checkView(s: UploadState, record: RoadmapFile, cloud: boolean, note: Note): { view: UploadView; review: UploadReview } {
  const review = uploadReview(s, record, NOW);
  const view = uploadView(s, record, NOW, review, cloud);
  checkText(view);
  const rows = allRows(view);
  // P1: each offered value once, as a row or a not-saved line, or behind its report's day question.
  const seen = new Map<string, number>();
  for (const row of rows) seen.set(key(row.fileId, row.ref), (seen.get(key(row.fileId, row.ref)) ?? 0) + 1);
  for (const [k, n] of seen) if (n > 1) fail('P1', `two rows for ${k}`);
  const notSavedLines = view.sections.flatMap((x) => (x.kind === 'notSaved' ? x.lines : []));
  const daySection = new Set(view.sections.flatMap((x) => (x.kind === 'undated' || x.kind === 'undatedPrevious' ? [x.fileId] : [])));
  review.labFiles.forEach((lf, i) => {
    const f = ('files' in s ? s.files : []).find((x) => x.id === lf.fileId)!;
    if (f.status.s !== 'read') return;
    const x = f.status.extraction;
    const refs = [...(x.values ?? []).map((_, j) => `v${j}`), ...(x.additionalValues ?? []).map((_, j) => `a${j}`)];
    for (const ref of refs) {
      const v = review.classification.values.find((c) => c.file === i && c.ref === ref);
      if (!v) fail('P1', `${lf.fileId} ${ref} not classified`);
      const asRow = seen.get(key(lf.fileId, ref)) ?? 0;
      if (asRow) { if (v!.group === 'notSaved' || v!.group === 'saved' || v!.group === 'waiting') fail('P1', `${ref} is ${v!.group} and a row`); continue; }
      if (v!.group === 'notSaved') { if (!notSavedLines.some((l) => l.includes(v!.label))) fail('P1', `${ref} not saved, in no line`); continue; }
      if (v!.group === 'saved') continue; // counted in the already-saved line (checked below), or an equal copy of a reading that saves
      if (v!.group === 'waiting') {
        if (daySection.has(lf.fileId)) continue;
        fail('P1', `${lf.fileId} ${ref} waits for a day no section asks (ticked ${lf.ticked.includes(ref)})`);
      }
      fail('P1', `${lf.fileId} ${ref} (${v!.group}) is missing from the view`);
    }
  });
  // P1: values held already, equal, are counted, as the web counts them (an equal copy of this upload's own reading is not).
  const held = review.classification.values.filter((v) => isOfferedRef(v.ref) && v.group === 'saved' && !('duplicate' in v && v.duplicate)).length;
  if ((view.alreadySaved ?? null) !== (held ? IMPORT_REVIEW_TEXT.alreadySaved(held) : null)) fail('P1', `already-saved line ${view.alreadySaved} for ${held}`);
  // A copy of another reading carries no Replace: Replace lives on the reading that holds the slot.
  for (const row of rows) if (row.copy && (row.replaces || row.replacing || row.replace)) fail('P2', `${row.fileId} ${row.ref} is a copy with a Replace`);
  // P2: shown writable == what the review writes == the plan's rows.
  const shown = shownWritable(view, review);
  const writes = written(review);
  const plan = uploadSavePlan(s, record, NOW, review, cloud);
  if (plan.labRows.flatMap((x) => x.rows).length !== writes.size) fail('P2', 'plan rows != written values');
  for (const k of writes) if (!shown.has(k)) fail('P2', `${k} is written but not shown ticked and writable`);
  for (const k of shown) if (!writes.has(k)) {
    const [fileId, ref] = k.split('|');
    const fi = review.labFiles.findIndex((x) => x.fileId === fileId);
    fail('P2', `${k} is shown ticked and writable but Save does not write it\nrow ${JSON.stringify(rows.find((x) => key(x.fileId, x.ref) === k))}\nvalue ${JSON.stringify(review.classification.values.find((v) => v.file === fi && v.ref === ref))}`);
  }
  // P3: the label and the lines count those rows and the documents shown.
  const docs = view.documents?.rows.length ?? 0;
  if (docs !== plan.documents.length) fail('P3', 'documents shown != planned');
  if (view.documents && view.documents.line !== UPLOAD_TEXT.documentsLine(docs)) fail('P3', 'documents line');
  const n = writes.size;
  const label = n || docs || !plan.counts.originals ? UPLOAD_TEXT.saveBoth(n, docs) : UPLOAD_TEXT.saveOriginals(plan.counts.originals);
  if (view.save.label !== label) fail('P3', `label ${view.save.label} != ${label}`);
  const sureWrites = (view.sure?.rows ?? []).filter((row) => writes.has(key(row.fileId, row.ref))).length;
  if (view.sure && view.sure.line !== IMPORT_REVIEW_TEXT.willSave(sureWrites)) fail('P3', `sure line ${view.sure.line} != ${sureWrites}`);
  checkDays(s, review);
  checkNumbers(s, review, rows, writes, record);
  checkOracles(s, review, record);
  // P4: a disabled Save with nothing in flight names a blocker the view lets the person clear.
  if ((s.phase === 'open' || s.phase === 'saveFailed') && !view.save.enabled && inFlight(s) === 0) {
    const why = view.save.why;
    if (!why) fail('P4', 'disabled with no reason');
    if (why === FIX_ERRORS_TEXT) {
      const errs = rows.filter((row) => row.error && row.ticked);
      if (!errs.length) fail('P4', 'fix errors, but no ticked row has an error');
      for (const row of errs) {
        const after = transition(s, { type: 'chose', id: row.fileId, change: { tick: row.ref, on: false }, now: NOW }).state;
        const again = uploadView(after, record, NOW, uploadReview(after, record, NOW), cloud);
        if (allRows(again).some((x) => x.fileId === row.fileId && x.ref === row.ref && x.error && x.ticked)) fail('P4', `unticking ${row.ref} leaves its error`);
      }
    } else if (why === UPLOAD_TEXT.chooseDay) {
      for (const lf of review.labFiles.filter((f) => f.needsDay)) {
        // A dated previous column's day has no control yet (US-13 AC24: the web's matrix draws it in a later PR): its pick resolves it.
        if ((lf.needsTestDay || lf.needsPreviousDay) && !daySection.has(lf.fileId)) fail('P4', `${lf.fileId} needs a day and no section asks it`);
        const changes: ChoiceChange[] = lf.needsTestDay ? [{ testDay: PICKED_DAY }] : lf.needsPreviousDay ? [{ previousDay: EARLY }] : columnFixes(s, lf);
        const after = changes.reduce<UploadState>((st, change) => transition(st, { type: 'chose', id: lf.fileId, change, now: NOW }).state, s);
        const again = uploadReview(after, record, NOW).labFiles.find((f) => f.fileId === lf.fileId)!;
        if (lf.needsTestDay ? again.needsTestDay : lf.needsPreviousDay ? again.needsPreviousDay : again.needsColumnDay) fail('P4', `choosing the day leaves ${lf.fileId} waiting`);
        // Never a day asked only for values the write refuses whatever the day (they sit under Not saved).
        const fi = review.labFiles.indexOf(lf);
        const dayless = review.classification.values.filter((v) => v.file === fi && !v.sent && lf.ticked.includes(v.ref));
        if (lf.needsTestDay && !dayless.some((v) => v.group === 'waiting' || (v.group === 'unsure' && v.reasons.includes('outOfRange')))) fail('P4', `${lf.fileId} asked a day only for values the write refuses`);
      }
    } else if (why !== UPLOAD_TEXT.saveNothing) fail('P4', `unknown blocker ${why}`);
  }
  return { view, review };
}

/**
 * P7: each row Save writes shows what Save writes: its number (an edit as typed; else as printed, whose SI
 * conversion is what a core value stores), its unit, its day; a Replace shows the value it replaces.
 */
function checkNumbers(s: UploadState, review: UploadReview, rows: ValueRow[], writes: Set<string>, record: RoadmapFile) {
  const planned = new Map(review.classification.values.filter((v) => v.sent && v.writes).map((v, k) => [key(review.labFiles[v.file].fileId, v.ref), review.classification.rows[k]]));
  const reads = new Map(('files' in s ? s.files : []).flatMap((f) => (f.status.s === 'read' ? [[f.id, f.status] as const] : [])));
  for (const row of rows) {
    const k = key(row.fileId, row.ref);
    const bulk = planned.get(k);
    if (!writes.has(k) || !bulk) continue;
    const edit = reads.get(row.fileId)?.choices.edits[row.ref];
    const shown = Number((row.value ?? '').replace(/^[<>]=?\s*/, ''));
    if (row.day !== bulk.recordedAt.slice(0, 10)) fail('P7', `${k} shows day ${row.day}, Save writes ${bulk.recordedAt}`);
    if (edit !== undefined) {
      if (shown !== edit || bulk.value !== edit) fail('P7', `${k} edited to ${edit}: shows ${row.value}, Save writes ${bulk.value}`);
    } else if (bulk.kind === 'measurement') {
      const si = reportedToCanonical(bulk.metricType as MetricType, shown, row.unit ?? '')?.valueSI;
      if (si === undefined || Math.abs(si - bulk.value) > 1e-6 * Math.max(1, Math.abs(si))) fail('P7', `${k} shows ${row.value} ${row.unit}, Save writes ${bulk.value} (SI ${si})`);
    } else if (shown !== bulk.value || row.unit !== bulk.unit) fail('P7', `${k} shows ${row.value} ${row.unit}, Save writes ${bulk.value} ${bulk.unit}`);
    if (bulk.correctsId) {
      const old = rowsOf(record).find((x) => x.id === bulk.correctsId);
      if (!old || !row.held?.includes(String(old.value))) fail('P7', `${k} replaces ${old?.value}, shows held ${row.held}`);
    }
  }
}

/**
 * Independent oracles (adversary R2), from the generated case and the record, never from the classifier's own rule:
 * a `saved` value has an equal active reading in its slot, or an equal reading of this upload there that writes or is
 * held; a not-saved value's reason is its generated cause (an unknown unit, a creatinine with no unit, an own day still
 * to come, or another reading of the test that day); a future-day value's own day is after today.
 */
function checkOracles(s: UploadState, review: UploadReview, record: RoadmapFile) {
  const today = NOW.slice(0, 10);
  const reads = new Map(('files' in s ? s.files : []).flatMap((f) => (f.status.s === 'read' ? [[f.id, f.status] as const] : [])));
  const held = rowsOf(record).filter(isActive);
  // A value not sent is judged on its printed number (import-review step 3); a sent one on the number Save sends.
  const facts = (fi: number, ref: string, sent = true) => {
    const lf = review.labFiles[fi];
    const st = reads.get(lf.fileId)!;
    const x = st.extraction;
    const printed = valueAt(x, ref)?.value;
    const own = printed?.recordedAt === UNDATED_PREVIOUS ? undefined : printed?.recordedAt;
    const { day } = expectedDay(st, ref);
    const edit = st.choices.edits[ref];
    const row = day ? importRow(x, ref, day, edit !== undefined && sent ? { edited: { value: edit } } : {}) : null;
    return { printed, own, row, slot: row ? slotKey(bulkRowTarget(row).slot, bulkRowTarget(row).metric, row.recordedAt) : null };
  };
  const values = review.classification.values;
  for (const v of values) {
    if (v.ref[0] === 'r') { if (v.group !== 'notSaved' || v.reason !== 'noUnit') fail('O', `${v.ref} refused row is ${v.group}`); continue; }
    if (!isOfferedRef(v.ref)) continue;
    // A value whose dated column waits for its pick has no day (US-13 AC24): it is never written. Its group is the
    // classifier's preview on the day it printed (KNOWN columnWaitsPreviewedOnPrintedDay, upload-view.gaps.test.ts).
    if (expectedDay(reads.get(review.labFiles[v.file].fileId)!, v.ref).waits) { if (v.sent && v.writes) fail('O', `${v.ref} waits for its column's day and is written`); continue; }
    const f = facts(v.file, v.ref, v.sent);
    if (v.group === 'saved') {
      if (!f.row || !f.slot) fail('O', `${v.ref} saved with no day`);
      const equal = (value: number) => Math.abs(value - f.row!.value) < 1e-9;
      const inRecord = held.some((h) => slotOfRow(h) === f.slot && equal(h.value) && (h.comparator ?? null) === (f.row!.comparator ?? null));
      const sibling = 'duplicate' in v && v.duplicate && values.some((o) => o !== v && o.sent && (o.writes || o.group === 'saved') && facts(o.file, o.ref).slot === f.slot && facts(o.file, o.ref).row && equal(facts(o.file, o.ref).row!.value));
      if (!inRecord && !sibling) fail('O', `${review.labFiles[v.file].fileId} ${v.ref} classed saved with no equal reading held or written in ${f.slot}`);
    }
    if (v.group === 'notSaved') {
      const unit = v.ref[0] === 'a' && (f.printed as { unit?: string } | undefined)?.unit === 'zzz';
      const future = f.own !== undefined && f.own > today;
      // Each generated cause; a value with two (an unknown unit on a day still to come) may be named for either.
      const causes = [...(unit ? ['unit'] : []), ...(future ? [v.ref[0] === 'v' ? 'futureCoreDay' : 'futureDay'] : [])];
      if (!causes.length) causes.push('sameDay');
      if (!causes.includes(v.reason)) fail('O', `${v.ref} not saved for ${v.reason}, its generated cause is ${causes.join(' or ')}`);
      if (causes[0] === 'sameDay' && !values.some((o) => o !== v && o.sent && facts(o.file, o.ref).slot === f.slot)) fail('O', `${v.ref} sameDay with no other reading that day`);
      if ((v.reason === 'futureDay' || v.reason === 'futureCoreDay') && !(f.own && f.own > today)) fail('O', `${v.ref} future-day with own day ${f.own}`);
    }
  }
}

/** P8: the review's day for each offered value (`days`, `waits`) is the one worked out from the extraction and the choices alone. */
function checkDays(s: UploadState, review: UploadReview) {
  for (const lf of review.labFiles) {
    const f = 'files' in s ? s.files.find((x) => x.id === lf.fileId) : undefined;
    if (f?.status.s !== 'read') continue;
    for (const { ref } of offeredValues(f.status.extraction)) {
      const want = expectedDay(f.status, ref);
      const got = lf.days[ref]?.slice(0, 10) ?? null;
      if (got !== want.day || lf.waits.includes(ref) !== want.waits) fail('P8', `${lf.fileId}|${ref} has day ${got}${lf.waits.includes(ref) ? ' (waits)' : ''}, expected ${want.day}${want.waits ? ' (waits)' : ''}`);
    }
  }
}

/**
 * A value's day from the raw extraction and the choices alone, never from the review: the test's (the picked day, else
 * the report's); its own printed day (one still to come as printed: it is never saved); the undated column's pick, or a
 * dated column's (US-13 AC24), when that is a real past day before the test's (any while the test has none), else none;
 * a dated column with a pick that is not such a day waits.
 */
function expectedDay(st: { extraction: UnifiedExtractionResult; choices: FileChoices }, ref: string): { day: string | null; waits: boolean } {
  const { extraction: x, choices } = st;
  const real = (d: string | null | undefined) => (d ? validDay(d, { now: NOW })?.slice(0, 10) ?? null : null);
  const test = real(choices.testDay ?? x.reportDate);
  const before = (pick: string | null | undefined) => { const d = real(pick); return d && (!test || d < test) ? d : null; };
  const printed = valueAt(x, ref)?.value.recordedAt;
  if (printed === undefined) return { day: test, waits: false };
  if (printed === UNDATED_PREVIOUS) return { day: before(choices.previousDay), waits: false };
  const pick = real(printed) ? choices.columnDays?.[printed] : undefined;
  if (pick === undefined) return { day: printed.slice(0, 10), waits: false };
  const day = before(pick);
  return { day, waits: day === null };
}

/** P5: FHIR after a commit of `before` into `after`. */
function checkFhir(before: RoadmapFile, after: RoadmapFile) {
  const slots = new Map<string, number>();
  for (const row of rowsOf(after)) if (isActive(row)) slots.set(slotOfRow(row), (slots.get(slotOfRow(row)) ?? 0) + 1);
  for (const [slot, n] of slots) if (n > 1) fail('P5', `${n} active rows in ${slot}`);
  const now = new Map(rowsOf(after).map((row) => [row.id, row]));
  for (const old of rowsOf(before)) {
    const next = now.get(old.id);
    if (!next) fail('P5', `row ${old.id} removed`);
    const flipped = isActive(old) && next!.status === 'entered-in-error';
    if (flipped) {
      if (!rowsOf(after).some((row) => row.correctsId === old.id && isActive(row))) fail('P5', `${old.id} flipped with no correction`);
      if (JSON.stringify({ ...next, status: old.status }) !== JSON.stringify(old)) fail('P5', `${old.id} changed beyond its status`);
    } else if (JSON.stringify(next) !== JSON.stringify(old)) fail('P5', `${old.id} mutated`);
  }
  for (const row of rowsOf(after)) {
    if (now.get(row.id) && rowsOf(before).some((b) => b.id === row.id)) continue;
    if (row.correctsId && !rowsOf(before).some((b) => b.id === row.correctsId)) fail('P5', `${row.id} corrects a row the record never held`);
  }
}

/** A cloud that keeps what is written; ids fixed so runs compare. */
function io(cloud: boolean, failWrites: readonly string[] = []): UploadSaveIO<string> {
  let n = 0;
  return cloud
    ? { holds: () => true, original: (id) => `bytes of ${id}`, mimeType: () => 'application/pdf', now: () => NOW, newId: () => `doc-${n++}`,
      write: async (_ref, _bytes, id) => { if (failWrites.includes(id)) throw new Error('The cloud refused it.'); } }
    : { holds: () => false, original: () => null, mimeType: () => '', write: async () => { throw new Error('no cloud'); }, now: () => NOW, newId: () => `doc-${n++}` };
}

/** The state as the engine door steps and views it: a Replace whose target left its slot dropped, its value unticked. */
function doorState(s: UploadState, record: RoadmapFile): UploadState {
  if (!('files' in s) || !s.files.some((f) => f.status.s === 'read' && Object.keys(f.status.choices.replace).length)) return s;
  const lost = lostReplaces(uploadReview(s, record, NOW), s);
  return lost.length ? transition(s, { type: 'replacesLost', lost }).state : s;
}

/** One sequence run step by step; every step checked. */
class Run {
  s: UploadState;
  record: RoadmapFile;
  last: { view: UploadView; review: UploadReview; record: RoadmapFile } | null = null;
  /** Rows the last commit wrote as corrections (Replace). */
  corrections = 0;
  /** The last step's view came after the door dropped a lost Replace. */
  lostReplace = false;
  /** The last commit's facts, for the reach counts: values skipped, originals unstored, originals filed behind a held row. */
  saved = { skipped: 0, unstored: 0, archiveOnly: 0 };
  constructor(readonly setup: Setup, readonly note: Note) { this.record = setup.record; this.s = initialUpload(setup.platform); }

  async apply(step: Step): Promise<void> {
    // The engine door drops a Replace whose target left its slot before each event and in each view (replacesLost).
    if (step.type === 'event') this.s = doorState(this.s, this.record);
    // The engine door fills what the page would write when Save is pressed (ios/engine/upload-doors.ts); the app computes nothing.
    // Save carries the drawn page's `reviewed`, echoed by the app as it was drawn (the view the person tapped).
    if (step.type === 'event' && step.e.type === 'saveStarted') this.s = transition(this.s, { ...step.e, reviewed: this.last?.view.reviewed }).state;
    else if (step.type === 'tap') {
      this.record = this.write(this.record, step.rows, step.merge, step.free);
      this.s = transition(doorState(this.s, this.record), { type: 'saveStarted', reviewed: this.last?.view.reviewed }).state;
    }
    else if (step.type === 'event') this.s = transition(this.s, step.e).state;
    else if (step.type === 'record') this.record = this.write(this.record, step.rows, step.merge);
    else if (step.type === 'delete') this.record = { ...this.record, labValues: this.record.labValues.map((l) => (l.id === step.id ? { ...l, status: 'entered-in-error' as const } : l)), measurements: this.record.measurements.map((m) => (m.id === step.id ? { ...m, status: 'entered-in-error' as const } : m)) };
    else await this.save(step);
    if (this.s.phase === 'done' || this.s.phase === 'saving') return;
    if (this.s.phase === 'open' || this.s.phase === 'saveFailed') {
      const door = doorState(this.s, this.record);
      this.lostReplace = door !== this.s;
      this.s = door;
    }
    const { view, review } = checkView(this.s, this.record, this.setup.cloud, this.note);
    this.last = { view, review, record: this.record };
  }

  /** Another writer's rows: on this record, or on another device's copy of the record as it was at the start, merged in. */
  private write(record: RoadmapFile, rows: BulkRow[], merge: boolean, free: string | null = null): RoadmapFile {
    if (free) record = { ...record, labValues: record.labValues.map((l) => (l.id === free ? { ...l, status: 'entered-in-error' as const } : l)), measurements: record.measurements.map((m) => (m.id === free ? { ...m, status: 'entered-in-error' as const } : m)) };
    if (!merge) return bulkAppendValues(record, rows, NOW).file;
    const remote = bulkAppendValues({ ...this.setup.record, meta: { ...this.setup.record.meta, lastDeviceId: 'other' } }, rows, NOW).file;
    return mergeFiles(record, remote, { deviceId: 'test', now: NOW });
  }

  private async save(step: Extract<Step, { type: 'save' }>) {
    if (this.s.phase !== 'saving') return;
    const seen = this.last;
    const atSave = step.meanwhile && step.when === 'beforeSave' ? this.write(this.record, step.meanwhile, step.merge, step.free) : this.record;
    const out = await uploadSave(this.s, atSave, NOW, this.setup.cloud, io(this.setup.cloud, this.setup.failWrites));
    // Refused only when the record changed after the review so that Save would refuse (a blood pressure's other half, say):
    // nothing is written, the app sends the refusal as a failed Save, and the next view names the blocker (P4).
    if (!out.ok && (atSave === seen?.record || out.reason !== 'not-ready')) fail('P4', `Save was enabled but uploadSave refused: ${out.message}`);
    if (!out.ok) { this.note('refusedAfterChange'); this.record = atSave; this.s = transition(this.s, { type: 'saveFailed', run: this.s.run, attempt: (this.s as { attempt: number }).attempt, message: out.message }).state; return; }
    // A failed save: the cloud refused the write, so nothing is committed.
    if (!step.ok) { this.s = transition(this.s, { type: 'saveFailed', run: this.s.run, attempt: (this.s as { attempt: number }).attempt, message: 'The cloud refused the write.' }).state; return; }
    const atCommit = step.meanwhile && step.when === 'beforeCommit' ? this.write(atSave, step.meanwhile, step.merge, step.free) : atSave;
    const { file, outcome } = out.commit(atCommit);
    checkFhir(atCommit, file);
    const added = rowsOf(file).filter((row) => !rowsOf(atCommit).some((b) => b.id === row.id) && isActive(row));
    this.corrections = added.filter((row) => row.correctsId).length;
    this.saved = { skipped: (outcome.skippedValues ?? 0) + (outcome.skippedLabValues ?? 0), unstored: outcome.unstored, archiveOnly: outcome.archived };
    if (added.length !== outcome.values) fail('P2', `outcome says ${outcome.values} values, the commit added ${added.length}`);
    const skipped = (outcome.skippedValues ?? 0) + (outcome.skippedLabValues ?? 0);
    if (seen) {
      // P2: what the view showed writable is what the commit added (metric, day, value, correctsId).
      const plan = uploadSavePlan(this.s, seen.record, NOW, seen.review, this.setup.cloud);
      const planned = plan.labRows.flatMap((x) => x.rows);
      // Slot and correction; a core value's number too (a lab's is stored in its catalog unit, or as a core value).
      const slotOf = (row: BulkRow) => slotKey(bulkRowTarget(row).slot, bulkRowTarget(row).metric, row.recordedAt);
      const coreValue = new Map(planned.flatMap((row) => (row.kind === 'measurement' ? [[slotOf(row), row.value] as const] : [])));
      const want = planned.map((row) => `${slotOf(row)}|${row.kind === 'measurement' ? row.value : ''}|${row.correctsId ?? ''}`).sort();
      const got = added.map((row) => `${slotOfRow(row)}|${coreValue.has(slotOfRow(row)) ? row.value : ''}|${row.correctsId ?? ''}`).sort();
      const changed = !!step.meanwhile || seen.record !== this.record;
      if (!changed && (JSON.stringify(want) !== JSON.stringify(got) || skipped)) fail('P2', `view planned ${JSON.stringify(want)}, commit added ${JSON.stringify(got)}, skipped ${skipped}`);
      // Nothing a person reviewed vanishes: each reviewed value not written is counted in the outcome.
      const missing = want.filter((w) => !got.includes(w)).length;
      // Every reviewed value is written, counted as skipped, or named as refused at the commit (a pressure pair turned).
      const refused = outcome.refused?.length ?? 0;
      if (refused) this.note('refusedAtCommit');
      if (changed && missing !== skipped + refused) fail('P2', `record changed: ${missing} reviewed values not written, ${skipped} counted\nwant ${JSON.stringify(want)}\ngot ${JSON.stringify(got)}`);
      // Never more: nothing is written that the page did not show as to be written.
      if (got.some((g) => !want.includes(g))) fail('P2', `written but never shown as to be written\nwant ${JSON.stringify(want)}\ngot ${JSON.stringify(got)}`);
      // P3: the done line says what the label promised, less what it counts as skipped.
      if (outcome.values !== plan.counts.values - skipped - refused) fail('P3', `label promised ${plan.counts.values} values, ${skipped} skipped, done says ${outcome.values}`);
      if (outcome.documents !== plan.counts.documents) fail('P3', `label promised ${plan.counts.documents} documents, done says ${outcome.documents}`);
      // A file with no original (a photo or a scan) plans no archive and no archive-only original; nothing it writes holds an original or a lab archive.
      const noOriginal = new Set(('files' in this.s ? this.s.files : []).filter((f) => f.original === false).map((f) => f.id));
      if ([...plan.labArchives, ...plan.archiveOnly].some((d) => noOriginal.has(d.fileId))) fail('P3', 'an original or archive planned for a file with none');
      // By bytes held only by such files: the same bytes picked from Files too may be archived.
      const pickedFiles = 'files' in this.s ? this.s.files : [];
      const withOriginal = new Set(pickedFiles.filter((f) => !noOriginal.has(f.id)).map((f) => f.hash));
      const noOriginalHashes = new Set(pickedFiles.filter((f) => noOriginal.has(f.id) && !withOriginal.has(f.hash)).map((f) => f.hash));
      const newDocs = file.documents.filter((d) => !atCommit.documents.some((b) => b.id === d.id));
      if (newDocs.some((d) => noOriginalHashes.has(d.contentHash ?? null) && (d.fileRef || d.metadata?.labArchive === true))) fail('P3', 'a file with no original wrote an original or a lab archive row');
      const unstoredPlanned = this.setup.cloud && [...plan.documents, ...plan.labArchives, ...plan.archiveOnly].some((d) => this.setup.failWrites.includes(d.fileId) && !noOriginal.has(d.fileId));
      if (unstoredPlanned !== outcome.unstored > 0) fail('P3', `unstored ${outcome.unstored}, a refused original planned: ${unstoredPlanned}`);
    }
    // P5: a repeat Save on the committed record adds nothing. Only where no other writer acted: then a value the first
    // Save counted as skipped (its slot taken, then freed again) is one the page did promise, and a repeat may write it.
    const quiet = seen?.record === atSave && atSave === atCommit;
    const again = quiet ? await uploadSave(this.s, file, NOW, this.setup.cloud, io(this.setup.cloud, this.setup.failWrites)) : null;
    if (again && !again.ok) fail('P5', `repeat Save refused: ${again.message}`);
    if (again?.ok) {
      const repeat = again.commit(file);
      // An original the cloud refused is tried again (US-14 AC4): its hash-only row may be filed afresh, never a new value or a new file.
      const liveHashes = (f: RoadmapFile) => JSON.stringify([...new Set(f.documents.filter((d) => !d.deleted).map((d) => d.contentHash))].sort());
      const clean = repeat.file === file || (outcome.unstored > 0 && liveHashes(repeat.file) === liveHashes(file) && rowsOf(repeat.file).length === rowsOf(file).length);
      if (!clean || repeat.outcome.values || repeat.outcome.documents) fail('P5', `a repeat Save wrote ${JSON.stringify(repeat.outcome)}`);
      if (repeat.file !== file) this.note('repeatRefilesUnstored');
    }
    this.record = file;
    this.s = transition(this.s, { type: 'saved', run: this.s.run, attempt: (this.s as { attempt: number }).attempt, outcome }).state;
    if (this.s.phase !== 'done') fail('P3', 'saved but not done');
    const done = uploadView(this.s, file, NOW, uploadReview(this.s, file, NOW), this.setup.cloud);
    checkText(done);
    if (done.done?.line !== UPLOAD_TEXT.savedLine(outcome.values, outcome.documents)) fail('P3', 'done line');
    const lines = [...(outcome.skippedValues ? [UPLOAD_TEXT.skippedLine(outcome.skippedValues, false)] : []), ...(outcome.skippedLabValues ? [UPLOAD_TEXT.skippedLine(outcome.skippedLabValues, true)] : [])];
    if (JSON.stringify(done.done?.skipped) !== JSON.stringify(lines)) fail('P3', `done skipped lines ${JSON.stringify(done.done?.skipped)}`);
    if (!!done.done?.unstored !== outcome.unstored > 0) fail('P3', 'unstored line');
    if (!!done.done?.notSaved.length !== !!outcome.refused?.length) fail('P3', `done not-saved lines ${JSON.stringify(done.done?.notSaved)}`);
  }
}

/** The next step for this run, from its state: landings first, chosen values among them, then Save. */
function genStep(r: () => number, run: Run, phase: { saves: number; chosen: number; resolved: number }): Step | null {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const coin = (p: number) => r() < p;
  const s = run.s;
  if (s.phase === 'choosing') {
    const n = 1 + Math.floor(r() * 3);
    // Some are a photo or a scan (`original: false`, US-52 AC13e): never an original or an archive row.
    const files: PickedFile[] = Array.from({ length: n }, (_, i) => ({ id: `f${i}`, name: `report-${i}.pdf`, bytes: 1, kind: 'file', ...(coin(0.25) ? { original: false as const } : {}) }));
    return { type: 'event', e: { type: 'picked', files, needsConsent: coin(0.2), now: NOW } };
  }
  if (s.phase === 'consent') return { type: 'event', e: { type: 'consented' } };
  if (s.phase === 'done' || s.phase === 'failed') return null;
  const run_ = s.run;
  if (s.phase === 'saving') {
    const meanwhile = coin(0.25) ? otherWriter(r, run) : null;
    // Another writer between Save and the commit: appends rows, or frees a held slot (a kept conflict's held row deleted).
    const free = coin(0.15) ? freeable(r, run) : null;
    return { type: 'save', ok: phase.saves > 0 || coin(0.85), meanwhile: meanwhile ?? (free ? [] : null), merge: coin(0.5), free, when: coin(0.5) ? 'beforeSave' : 'beforeCommit' };
  }
  if (s.phase === 'saveFailed') {
    phase.saves++;
    // A choice on a row the view shows (an erroring one first, when Save waits on it), or Save again when the view lets it.
    const shown = run.last ? allRows(run.last.view) : [];
    const row = shown.find((x) => x.error && x.ticked) ?? (shown.length && coin(0.3) ? pick(shown) : undefined);
    if (row) return { type: 'event', e: { type: 'chose', id: row.fileId, change: { tick: row.ref, on: !row.ticked }, now: NOW } };
    return run.last?.view.save.enabled ? tapOrSave(r, run) : null;
  }
  // open
  const busy = s.files.filter((f) => ['hashing', 'converting', 'sending'].includes(f.status.s));
  const read = s.files.filter((f) => f.status.s === 'read');
  const roll = r();
  if (busy.length && roll < 0.7) {
    const f = pick(busy);
    if (f.status.s === 'hashing') {
      const twin = coin(0.05) && s.files[0].id !== f.id ? s.files[0].hash ?? `h-${f.id}` : `h-${f.id}`;
      if (coin(0.03)) return { type: 'event', e: { type: 'hashFailed', run: run_, id: f.id } };
      // Known as the engine door says it (knownAs on the record), and sometimes a known the record does not show.
      const known = knownAs(knownIndex(run.record), twin) ?? (coin(0.05) ? { as: pick(['document', 'labReport'] as const), archiveOnly: coin(0.5) } : null);
      return { type: 'event', e: { type: 'hashed', run: run_, id: f.id, hash: twin, known } };
    }
    if (f.status.s === 'converting') {
      if (coin(0.03)) return { type: 'event', e: { type: 'convertFailed', run: run_, id: f.id, reason: pick(['unreadable', 'timeout'] as const) } };
      return { type: 'event', e: { type: 'converted', run: run_, id: f.id, pages: 1, truncated: coin(0.1) } };
    }
    if (coin(0.1)) return { type: 'event', e: { type: 'sendFailed', run: run_, id: f.id, failure: pick(['busy', 'network', 'refused'] as const) } };
    return { type: 'event', e: { type: 'answered', run: run_, id: f.id, extraction: run.setup.extractions[f.id], legacy: coin(0.03), now: NOW } };
  }
  if (roll < 0.74) return { type: 'event', e: { type: 'retry', id: 'all' } };
  if (roll < 0.76 && busy.length) return { type: 'event', e: { type: 'stop' } };
  if (roll < 0.8 && phase.chosen < 30) {
    // Mostly a write; sometimes a deletion of a held row, often the one a Replace aims at.
    const aimed = s.files.flatMap((f) => (f.status.s === 'read' ? Object.values(f.status.choices.replace) : []));
    const live = rowsOf(run.record).filter(isActive).map((x) => x.id);
    const target = aimed.find((id) => live.includes(id)) ?? (live.length ? pick(live) : null);
    if (target && coin(0.3)) return { type: 'delete', id: target };
    return { type: 'record', rows: otherWriter(r, run), merge: coin(0.4) };
  }
  if (read.length && (busy.length || phase.chosen < 6 || coin(0.6)) && phase.chosen < 30) {
    phase.chosen++;
    const f = pick(read);
    const change = genChange(r, run, f.id);
    if (change) return { type: 'event', e: { type: 'chose', id: f.id, change, now: NOW } };
  }
  if (busy.length) return { type: 'event', e: { type: 'retry', id: 'all' } };
  // Save blocked: clear it as the person would, through the control the view gives (P4 checked it exists).
  const v = run.last?.view;
  if (v && !v.save.enabled && phase.resolved < 12 && coin(0.9)) {
    phase.resolved++;
    const err = allRows(v).find((row) => row.error && row.ticked);
    if (err) return { type: 'event', e: { type: 'chose', id: err.fileId, change: coin(0.6) ? { tick: err.ref, on: false } : { edit: err.ref, value: 3.1 }, now: NOW } };
    const day = v.sections.find((x) => x.kind === 'undated');
    if (day && day.kind === 'undated') return { type: 'event', e: { type: 'chose', id: day.fileId, change: { testDay: coin(0.8) ? PICKED_DAY : DAY }, now: NOW } };
    const prev = v.sections.find((x) => x.kind === 'undatedPrevious');
    if (prev && prev.kind === 'undatedPrevious') return { type: 'event', e: { type: 'chose', id: prev.fileId, change: { previousDay: coin(0.8) ? EARLY : PAST }, now: NOW } };
    const column = run.last?.review.labFiles.find((f) => f.needsColumnDay);
    if (column) return { type: 'event', e: { type: 'chose', id: column.fileId, change: columnFixes(s, column)[0], now: NOW } };
  }
  // Nothing in flight: Save as the person would, only when the view enables it; else give up the sequence.
  if (run.last?.view.save.enabled) return tapOrSave(r, run);
  return null;
}

/**
 * A change the list lets the person make: on a row it shows (tick, Replace with the row's held id or
 * a stale one, an edit), the test's day only while the undated section asks it, a document's fixes.
 * The previous column's day on the web, while the file prints one (the phone never asks for one): a past day before the
 * report's, one on or after it, a partial pick, or none; a dated previous column's day on the web (US-13 AC24).
 */
function genChange(r: () => number, run: Run, fileId: string): ChoiceChange | null {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const coin = (p: number) => r() < p;
  const f = 'files' in run.s ? run.s.files.find((x) => x.id === fileId) : undefined;
  const view = run.last?.view;
  if (f?.status.s !== 'read' || !view) return null;
  if (f.status.extraction.classification !== 'lab_report') {
    const k = r();
    if (k < 0.3) return { document: { title: pick(['Renamed letter', 'Letter from the clinic']) } };
    if (k < 0.6) return { document: { kind: pick(['clinic_letter', 'scan_result', 'other']) } };
    return { document: { date: pick(['2026-10-10', null, FUTURE, '2026-02-30']) } };
  }
  const rows = allRows(view).filter((row) => row.fileId === fileId);
  const asksDay = view.sections.some((x) => x.kind === 'undated' && x.fileId === fileId);
  // The phone's pickers offer only days up to today (UploadReviewView.swift `in: ...Date.now`, DayCalendar).
  if (asksDay && (!rows.length || coin(0.4))) return { testDay: pick([PICKED_DAY, DAY, PAST]) };
  const printsUndated = [...(f.status.extraction.values ?? []), ...(f.status.extraction.additionalValues ?? [])].some((x) => x.recordedAt === UNDATED_PREVIOUS);
  if (printsUndated && coin(0.3)) return { previousDay: pick([EARLY, PAST, PICKED_DAY, DAY, '2026-10', null]) };
  // A dated previous column's day, on the web only (US-13 AC24): a valid early day, a partial pick that waits, or another column's printed day.
  const columns = printedDays(f.status.extraction);
  if (run.setup.platform === 'web' && columns.length && coin(0.25)) {
    const columnDay = pick(columns);
    const others = columns.filter((d) => d !== columnDay);
    return { columnDay, day: pick([EARLY, '2026-10', ...(others.length ? [pick(others)] : [])]) };
  }
  if (!rows.length) return null;
  const row = pick(rows);
  const k = r();
  if (k < 0.45) return { tick: row.ref, on: !row.ticked };
  if (k < 0.75) {
    if (row.replacing) return { replace: row.ref, correctsId: null };
    const stale = rowsOf(run.record).filter((x) => !isActive(x)).map((x) => x.id);
    const correctsId = row.replaces && coin(0.8) ? row.replaces : stale.length ? pick(stale) : 'no-such-row';
    return row.replaces || coin(0.2) ? { replace: row.ref, correctsId } : { tick: row.ref, on: !row.ticked };
  }
  return { edit: row.ref, value: pick([2.0, 3.1, 52, 500, null, Number.NaN]) };
}

/** The real past days a report's values printed: each a dated column the web's review can move (US-13 AC24). */
const printedDays = (x: UnifiedExtractionResult): string[] =>
  [...new Set(offeredValues(x).map(({ value }) => value.recordedAt).filter((d): d is string => !!d && !!validDay(d, { now: NOW })))];

/** A valid early day for each column a lab file waits on (`waits`, by the day each value printed). */
function columnFixes(s: UploadState, lf: UploadReview['labFiles'][number]): ChoiceChange[] {
  const f = 'files' in s ? s.files.find((x) => x.id === lf.fileId) : undefined;
  if (f?.status.s !== 'read') return [];
  const { extraction } = f.status;
  return [...new Set(lf.waits.map((ref) => valueRecordedAt(extraction, ref)!))].map((columnDay) => ({ columnDay, day: EARLY }));
}

/** Save as the person taps it; sometimes another writer acts between the drawn page and the tap. */
function tapOrSave(r: () => number, run: Run): Step {
  if (r() >= 0.25) return { type: 'event', e: { type: 'saveStarted' } };
  const free = r() < 0.5 ? freeable(r, run) : null;
  return { type: 'tap', rows: free ? [] : otherWriter(r, run), merge: r() < 0.3, free };
}

/** A held row to delete, often one a value of the upload meets in its slot. */
function freeable(r: () => number, run: Run): string | null {
  const live = rowsOf(run.record).filter(isActive).map((x) => x.id);
  return live.length ? live[Math.floor(r() * live.length)] : null;
}

/** Another writer's rows: fill a slot the upload aims at, or correct a held row (a Replace's target moves). */
function otherWriter(r: () => number, run: Run): BulkRow[] {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const held = rowsOf(run.record).filter(isActive);
  if (held.length && r() < 0.4) {
    const row = pick(held);
    return ['metricType' in row || row.core
      ? { kind: 'measurement', metricType: 'metricType' in row ? row.metricType : row.metricName, value: row.value + 0.5, recordedAt: row.recordedAt.slice(0, 10), source: 'manual', correctsId: row.id }
      : { kind: 'lab', metricName: row.metricName, value: row.value + 1, unit: row.unit, referenceLow: null, referenceHigh: null, recordedAt: row.recordedAt.slice(0, 10), source: 'manual', correctsId: row.id }];
  }
  return [pick<BulkRow>([
    { kind: 'measurement', metricType: 'ldl', value: 2.7, recordedAt: pick([DAY, PAST, PICKED_DAY]), source: 'manual' },
    { kind: 'measurement', metricType: 'hba1c', value: 48, recordedAt: pick([DAY, PAST]), source: 'manual' },
    { kind: 'measurement', metricType: 'diastolic_bp', value: 125, recordedAt: pick([DAY, PAST]), source: 'manual' },
    { kind: 'lab', metricName: 'Ferritin', value: 70, unit: 'µg/L', referenceLow: null, referenceHigh: null, recordedAt: pick([DAY, PAST]), source: 'manual' },
  ])];
}

function genSetup(r: () => number): Setup {
  const extractions: Record<string, UnifiedExtractionResult> = {};
  const platform: UploadPlatform = r() < 0.5 ? 'web' : 'phone';
  for (let i = 0; i < 3; i++) extractions[`f${i}`] = r() < 0.75 ? genLab(r, platform) : genLetter(r);
  return { extractions, record: genRecord(r), cloud: r() < 0.5, failWrites: r() < 0.2 ? ['f0'] : [], platform };
}

/** Runs `steps` from scratch; the failure's property, or null. */
async function replay(setup: Setup, steps: Step[]): Promise<Failure | null> {
  const run = new Run(setup, () => {});
  try { for (const step of steps) await run.apply(step); } catch (e) { if (e instanceof Failure) return e; throw e; }
  return null;
}

/** Drops steps one at a time while the same property still fails. */
async function minimise(setup: Setup, steps: Step[], prop: string): Promise<Step[]> {
  let cur = steps;
  for (let i = cur.length - 1; i >= 0; i--) {
    const next = [...cur.slice(0, i), ...cur.slice(i + 1)];
    const f = await replay(setup, next);
    if (f?.prop === prop) cur = next;
  }
  return cur;
}

/** The setup as a reader needs it: each file's values, the record's rows by slot, the cloud. */
const brief = (setup: Setup) => JSON.stringify({
  files: Object.fromEntries(Object.entries(setup.extractions).map(([id, x]) => [id, x.classification !== 'lab_report' ? x.classification
    : { reportDate: x.reportDate, values: [...(x.values ?? []).map((v) => `${v.metric} ${v.valueSI} ${v.recordedAt ?? '-'}${v.question ? ' q' : ''}${v.unitGuessed ? ' guessed' : ''}`), ...(x.additionalValues ?? []).map((v) => `${v.name} ${v.value} ${v.unit} ${v.recordedAt ?? '-'}`)], refused: x.refusedValues?.length ?? 0 }])),
  record: rowsOf(setup.record).map((row) => `${row.id.slice(0, 4)} ${slotOfRow(row)} ${row.value} ${row.status}`),
  cloud: setup.cloud,
});

/** A Replace the run had chosen was just dropped by the door (its target deleted). */
const lostBefore = (run: Run) => run.lostReplace;

/** A row drawn to be written whose day is a column pick, not the day it printed (US-13 AC24). */
const movedColumn = (view: UploadView, review: UploadReview, s: UploadState) => (view.reviewed ?? []).some((w) => {
  const f = 'files' in s ? s.files.find((x) => x.id === w.file) : undefined;
  const lf = review.labFiles.find((x) => x.fileId === w.file);
  const printed = f?.status.s === 'read' ? valueRecordedAt(f.status.extraction, w.ref) : undefined;
  const day = lf?.days[w.ref]?.slice(0, 10);
  return !!printed && printed !== UNDATED_PREVIOUS && !!day && day !== printed && allRows(view).some((row) => row.fileId === w.file && row.ref === w.ref && row.day === day);
});

const valueRecordedAt = (x: UnifiedExtractionResult, ref: string) => valueAt(x, ref)?.value.recordedAt;

const SEEDS = 3000;

describe('upload-view property: the list view against Save (US-52 AC8c, US-13 AC13)', () => {
  it(`holds for ${SEEDS} seeded uploads, P1-P6 after every step`, async () => {
    const gaps: Record<string, number[]> = {};
    const reach = {
      steps: 0, saved: 0, saveFailedThenSaved: 0, replacing: 0, corrections: 0, changedBeforeSave: 0, blockedFix: 0, blockedDay: 0, conflicts: 0, documents: 0,
      merges: 0, replaceLost: 0, changedBeforeTap: 0, freedBeforeCommit: 0, skipped: 0, unstored: 0, archiveOnly: 0, copies: 0, alreadySaved: 0, futureDay: 0, undatedPrevious: 0, pressureRefused: 0, limitTicked: 0, labAsCore: 0, edited: 0, noOriginalSaved: 0, columnMoved: 0,
    };
    for (let seed = 1; seed <= SEEDS; seed++) {
      const r = mulberry32(seed);
      const setup = genSetup(r);
      const run = new Run(setup, (gap) => { const seeds = (gaps[gap] ??= []); if (seeds[seeds.length - 1] !== seed) seeds.push(seed); });
      const steps: Step[] = [];
      const phase = { saves: 0, chosen: 0, resolved: 0 };
      for (let i = 0; i < 200; i++) {
        const step = genStep(r, run, phase);
        if (!step) break;
        steps.push(step);
        try { await run.apply(step); } catch (e) {
          if (!(e instanceof Failure)) throw e;
          const small = await minimise(setup, steps, e.prop);
          throw new Error(`${e.message}\nseed ${seed}, step ${i}\nsetup: ${brief(setup)}\nminimised steps: ${JSON.stringify(small)}`);
        }
        reach.steps++;
        if (step.type === 'save' && run.s.phase === 'done') reach.corrections += run.corrections;
        // A dated previous column's value moved by its pick, drawn to be written on the page Save ran from and saved (P7 checked its day).
        if (step.type === 'save' && run.s.phase === 'done' && run.last && movedColumn(run.last.view, run.last.review, run.s)) reach.columnMoved++;
        if (run.s.phase === 'done') { reach.saved++; if (phase.saves) reach.saveFailedThenSaved++; if (run.s.files.some((f) => f.original === false)) reach.noOriginalSaved++; }
        if (step.type === 'save' && step.meanwhile) reach.changedBeforeSave++;
        if (step.type === 'tap') reach.changedBeforeTap++;
        if (step.type === 'save' && step.free) reach.freedBeforeCommit++;
        if ((step.type === 'record' || (step.type === 'save' && step.meanwhile)) && step.merge) reach.merges++;
        if (step.type === 'delete' && lostBefore(run)) reach.replaceLost++;
        if (step.type === 'save' && run.s.phase === 'done') { reach.skipped += run.saved.skipped; reach.unstored += run.saved.unstored; reach.archiveOnly += run.saved.archiveOnly; }
        const v = run.last?.view;
        if (v && run.s.phase === 'open' && !inFlight(run.s)) {
          if (v.save.why === FIX_ERRORS_TEXT) reach.blockedFix++;
          if (v.save.why === UPLOAD_TEXT.chooseDay) reach.blockedDay++;
          if (allRows(v).some((row) => row.replacing)) reach.replacing++;
          if (allRows(v).some((row) => row.conflict)) reach.conflicts++;
          if (v.documents) reach.documents++;
          if (allRows(v).some((row) => row.copy)) reach.copies++;
          if (v.alreadySaved) reach.alreadySaved++;
          if (v.sections.some((x) => x.kind === 'notSaved' && x.lines.some((l) => l.includes(LAB_DAY_REFUSAL) || l.includes(DAY_NOT_HAPPENED)))) reach.futureDay++;
          if (allRows(v).some((row) => row.error === PRESSURE_ORDER)) reach.pressureRefused++;
          if (allRows(v).some((row) => row.ticked && row.value?.startsWith('<'))) reach.limitTicked++;
          if (allRows(v).some((row) => row.ticked && row.ref[0] === 'a' && row.label === 'LDL Cholesterol')) reach.labAsCore++;
          if (run.s.files.some((f) => f.status.s === 'read' && Object.keys(f.status.choices.edits).length)) reach.edited++;
          // A value of the undated previous column on a picked day, shown to be written (P7 checks its day).
          if (allRows(v).some((row) => run.last?.view.reviewed?.some((w) => w.file === row.fileId && w.ref === row.ref) && run.s.phase === 'open' && run.s.files.some((f) => f.id === row.fileId && f.status.s === 'read' && valueRecordedAt(f.status.extraction, row.ref) === UNDATED_PREVIOUS))) reach.undatedPrevious++;
        }
      }
    }
    if (process.env.UPLOAD_VIEW_PROPERTY_OUT) writeFileSync(process.env.UPLOAD_VIEW_PROPERTY_OUT, JSON.stringify({ reach, gaps: Object.fromEntries(Object.entries(gaps).map(([k, v]) => [k, { seqs: v.length, first: v.slice(0, 5) }])) }, null, 1));
    expect(reach.steps).toBeGreaterThan(20000);
    for (const [name, k] of Object.entries(reach)) expect([name, k > 0]).toEqual([name, true]);
  }, 60_000);
});

