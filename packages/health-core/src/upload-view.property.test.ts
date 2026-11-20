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
 * The gaps it found (owner rulings 2026-11-20) are pinned, fixed, in upload-view.gaps.test.ts.
 * Synthetic values, names and hashes only.
 */
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AdditionalLabValue, ExtractedValue, UnifiedExtractionResult } from './lab-extraction';
import { bulkRowTarget } from './bulk-row-target';
import { bulkAppendValues, LAB_DAY_REFUSAL, slotKey, slotOfRow, type BulkRow } from './record-edits';
import { mergeFiles } from './merge';
import { knownAs, knownIndex } from './upload-known';
import { reportedToCanonical, type MetricType } from './units';
import { PRESSURE_ORDER } from './validation';
import { createEmptyFile, type FileLabValue, type FileMeasurement, type RoadmapFile } from './roadmap-file';
import type { ChoiceChange } from './upload-choices';
import { initialUpload, inFlight, transition, type PickedFile, type UploadEvent, type UploadState } from './upload-flow';
import { uploadSavePlan } from './upload-plan';
import { lostReplaces, reviewedWrites, uploadReview, type UploadReview } from './upload-review';
import { uploadSave, type UploadSaveIO } from './upload-save';
import { uploadView, type UploadView, type ValueRow } from './upload-view';
import { FIX_ERRORS_TEXT, UPLOAD_TEXT } from './upload-text';
import { IMPORT_REVIEW_TEXT, isOfferedRef } from './import-review';

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
/** A misread report date that has not happened: the only way the server keeps a future own day (lab-extraction.ts `ownDay`: own < report). */
const REPORT_FUTURE = '2026-12-15';

// --- setup: what the reads answer and what the record holds ---------------------------------

const core = (over: Partial<ExtractedValue>): ExtractedValue => ({ metric: 'ldl', valueSI: 3.1, displayValue: 3.1, displayUnit: 'mmol/L', displaySystem: 'si', confidence: 'high', ...over });
const extra = (over: Partial<AdditionalLabValue>): AdditionalLabValue => ({ name: 'Ferritin', value: 80, unit: 'µg/L', ...over });

/** `failWrites`: files whose original the cloud refuses (an unstored original). */
interface Setup { extractions: Record<string, UnifiedExtractionResult>; record: RoadmapFile; cloud: boolean; failWrites: string[] }

/** One lab report: core values (ldl, hba1c) and labs from a small pool, each on no day, a past day or (rarely) a future one. */
function genLab(r: () => number): UnifiedExtractionResult {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const coin = (p: number) => r() < p;
  const reportDate = coin(0.65) ? DAY : coin(0.9) ? null : REPORT_FUTURE;
  // The server keeps an own day only before the report's full day (lab-extraction.ts `ownDay`): none on an undated
  // report, and a future one only before a future report date.
  const own = () => (reportDate === null || coin(0.6) ? undefined : reportDate === REPORT_FUTURE && coin(0.5) ? FUTURE : PAST);
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
  /** One Save as the platform runs it: `uploadSave` on the record, commit on it, or on it after `meanwhile`. */
  | { type: 'save'; ok: boolean; meanwhile: BulkRow[] | null; merge: boolean; when: 'beforeSave' | 'beforeCommit' };

type Row = FileMeasurement | FileLabValue;
const rowsOf = (f: RoadmapFile): Row[] => [...f.measurements, ...f.labValues];
const isActive = (row: Row) => (row.status ?? 'active') === 'active';
const key = (fileId: string, ref: string) => `${fileId}|${ref}`;

/** The rows the view shows ticked and writable: ticked, no error, not out of range, no conflict kept, the report not waiting for its day. */
function shownWritable(view: UploadView, review: UploadReview): Set<string> {
  const waiting = new Set(review.labFiles.filter((f) => f.needsDay).map((f) => f.fileId));
  const out = new Set<string>();
  for (const row of allRows(view)) {
    if (!row.ticked || row.error || row.reasons.includes('outOfRange') || waiting.has(row.fileId)) continue;
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
  checkNumbers(s, review, rows, writes, record);
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
        if (!daySection.has(lf.fileId)) fail('P4', `${lf.fileId} needs a day and no section asks it`);
        const change: ChoiceChange = lf.needsTestDay ? { testDay: PICKED_DAY } : { previousDay: PAST };
        const after = transition(s, { type: 'chose', id: lf.fileId, change, now: NOW }).state;
        const again = uploadReview(after, record, NOW).labFiles.find((f) => f.fileId === lf.fileId)!;
        if (lf.needsTestDay ? again.needsTestDay : again.needsPreviousDay) fail('P4', `choosing the day leaves ${lf.fileId} waiting`);
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
  s: UploadState = initialUpload('phone');
  record: RoadmapFile;
  last: { view: UploadView; review: UploadReview; record: RoadmapFile } | null = null;
  /** Rows the last commit wrote as corrections (Replace). */
  corrections = 0;
  /** The last step's view came after the door dropped a lost Replace. */
  lostReplace = false;
  /** The last commit's facts, for the reach counts: values skipped, originals unstored, originals filed behind a held row. */
  saved = { skipped: 0, unstored: 0, archiveOnly: 0 };
  constructor(readonly setup: Setup, readonly note: Note) { this.record = setup.record; }

  async apply(step: Step): Promise<void> {
    // The engine door drops a Replace whose target left its slot before each event and in each view (replacesLost).
    if (step.type === 'event') this.s = doorState(this.s, this.record);
    // The engine door fills what the page would write when Save is pressed (ios/engine/upload-doors.ts); the app computes nothing.
    if (step.type === 'event' && step.e.type === 'saveStarted') this.s = transition(this.s, { ...step.e, reviewed: reviewedWrites(uploadReview(this.s, this.record, NOW)) }).state;
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
  private write(record: RoadmapFile, rows: BulkRow[], merge: boolean): RoadmapFile {
    if (!merge) return bulkAppendValues(record, rows, NOW).file;
    const remote = bulkAppendValues({ ...this.setup.record, meta: { ...this.setup.record.meta, lastDeviceId: 'other' } }, rows, NOW).file;
    return mergeFiles(record, remote, { deviceId: 'test', now: NOW });
  }

  private async save(step: Extract<Step, { type: 'save' }>) {
    if (this.s.phase !== 'saving') return;
    const seen = this.last;
    const atSave = step.meanwhile && step.when === 'beforeSave' ? this.write(this.record, step.meanwhile, step.merge) : this.record;
    const out = await uploadSave(this.s, atSave, NOW, this.setup.cloud, io(this.setup.cloud, this.setup.failWrites));
    // Refused only when the record changed after the review so that Save would refuse (a blood pressure's other half, say):
    // nothing is written, the app sends the refusal as a failed Save, and the next view names the blocker (P4).
    if (!out.ok && (atSave === seen?.record || out.reason !== 'not-ready')) fail('P4', `Save was enabled but uploadSave refused: ${out.message}`);
    if (!out.ok) { this.note('refusedAfterChange'); this.record = atSave; this.s = transition(this.s, { type: 'saveFailed', run: this.s.run, attempt: (this.s as { attempt: number }).attempt, message: out.message }).state; return; }
    // A failed save: the cloud refused the write, so nothing is committed.
    if (!step.ok) { this.s = transition(this.s, { type: 'saveFailed', run: this.s.run, attempt: (this.s as { attempt: number }).attempt, message: 'The cloud refused the write.' }).state; return; }
    const atCommit = step.meanwhile && step.when === 'beforeCommit' ? this.write(atSave, step.meanwhile, step.merge) : atSave;
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
      // OPEN gap: a reviewed value the commit refuses on the changed record (a blood pressure's other half arrived) is
      // counted nowhere; the held web branch names it (`SaveOutcome.refused`), not ported here.
      const dry = bulkAppendValues(atCommit, planned, NOW);
      const refusedAtCommit = dry.refused.length + dry.measurementRefusals.length;
      if (changed && missing > skipped && missing <= skipped + refusedAtCommit) this.note('refusedAtCommitUnnamed');
      else if (changed && missing !== skipped) fail('P2', `record changed: ${missing} reviewed values not written, ${skipped} counted\nwant ${JSON.stringify(want)}\ngot ${JSON.stringify(got)}`);
      if (changed && got.some((g) => !want.includes(g))) this.note('writtenUnreviewed');
      // P3: the done line says what the label promised, less what it counts as skipped.
      const unnamed = changed && missing > skipped && missing <= skipped + refusedAtCommit ? missing - skipped : 0;
      if (outcome.values !== plan.counts.values - skipped - unnamed) fail('P3', `label promised ${plan.counts.values} values, ${skipped} skipped, done says ${outcome.values}`);
      if (outcome.documents !== plan.counts.documents) fail('P3', `label promised ${plan.counts.documents} documents, done says ${outcome.documents}`);
      const unstoredPlanned = this.setup.cloud && [...plan.documents, ...plan.labArchives, ...plan.archiveOnly].some((d) => this.setup.failWrites.includes(d.fileId));
      if (unstoredPlanned !== outcome.unstored > 0) fail('P3', `unstored ${outcome.unstored}, a refused original planned: ${unstoredPlanned}`);
    }
    // P5: a repeat Save on the committed record adds nothing.
    const again = await uploadSave(this.s, file, NOW, this.setup.cloud, io(this.setup.cloud, this.setup.failWrites));
    // A repeat on a record another writer changed may now be refused (a pair the wrong way up): it writes nothing, which P5 asks.
    if (!again.ok && !(again.reason === 'not-ready' && atCommit !== atSave || again.reason === 'not-ready' && seen?.record !== atSave)) fail('P5', `repeat Save refused: ${again.message}`);
    if (again.ok) {
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
  }
}

/** The next step for this run, from its state: landings first, chosen values among them, then Save. */
function genStep(r: () => number, run: Run, phase: { saves: number; chosen: number; resolved: number }): Step | null {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const coin = (p: number) => r() < p;
  const s = run.s;
  if (s.phase === 'choosing') {
    const n = 1 + Math.floor(r() * 3);
    const files: PickedFile[] = Array.from({ length: n }, (_, i) => ({ id: `f${i}`, name: `report-${i}.pdf`, bytes: 1, kind: 'file' }));
    return { type: 'event', e: { type: 'picked', files, needsConsent: coin(0.2), now: NOW } };
  }
  if (s.phase === 'consent') return { type: 'event', e: { type: 'consented' } };
  if (s.phase === 'done' || s.phase === 'failed') return null;
  const run_ = s.run;
  if (s.phase === 'saving') {
    const meanwhile = coin(0.25) ? otherWriter(r, run) : null;
    return { type: 'save', ok: phase.saves > 0 || coin(0.85), meanwhile, merge: coin(0.5), when: coin(0.5) ? 'beforeSave' : 'beforeCommit' };
  }
  if (s.phase === 'saveFailed') {
    phase.saves++;
    // A choice on a row the view shows (an erroring one first, when Save waits on it), or Save again when the view lets it.
    const shown = run.last ? allRows(run.last.view) : [];
    const row = shown.find((x) => x.error && x.ticked) ?? (shown.length && coin(0.3) ? pick(shown) : undefined);
    if (row) return { type: 'event', e: { type: 'chose', id: row.fileId, change: { tick: row.ref, on: !row.ticked }, now: NOW } };
    return run.last?.view.save.enabled ? { type: 'event', e: { type: 'saveStarted' } } : null;
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
  }
  // Nothing in flight: Save as the person would, only when the view enables it; else give up the sequence.
  if (run.last?.view.save.enabled) return { type: 'event', e: { type: 'saveStarted' } };
  return null;
}

/**
 * A change the list lets the person make: on a row it shows (tick, Replace with the row's held id or
 * a stale one, an edit), the test's day only while the undated section asks it, a document's fixes.
 * The phone's list has no previous-column day (the phone never asks for one).
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
  for (let i = 0; i < 3; i++) extractions[`f${i}`] = r() < 0.75 ? genLab(r) : genLetter(r);
  return { extractions, record: genRecord(r), cloud: r() < 0.5, failWrites: r() < 0.2 ? ['f0'] : [] };
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

const SEEDS = 3000;

describe('upload-view property: the list view against Save (US-52 AC8c, US-13 AC13)', () => {
  it(`holds for ${SEEDS} seeded uploads, P1-P6 after every step`, async () => {
    const gaps: Record<string, number[]> = {};
    const reach = {
      steps: 0, saved: 0, saveFailedThenSaved: 0, replacing: 0, corrections: 0, changedBeforeSave: 0, blockedFix: 0, blockedDay: 0, conflicts: 0, documents: 0,
      merges: 0, replaceLost: 0, skipped: 0, unstored: 0, archiveOnly: 0, copies: 0, alreadySaved: 0, futureDay: 0, pressureRefused: 0, limitTicked: 0, labAsCore: 0, edited: 0,
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
        if (run.s.phase === 'done') { reach.saved++; if (phase.saves) reach.saveFailedThenSaved++; }
        if (step.type === 'save' && step.meanwhile) reach.changedBeforeSave++;
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
          if (v.sections.some((x) => x.kind === 'notSaved' && x.lines.some((l) => l.includes(LAB_DAY_REFUSAL)))) reach.futureDay++;
          if (allRows(v).some((row) => row.error === PRESSURE_ORDER)) reach.pressureRefused++;
          if (allRows(v).some((row) => row.ticked && row.value?.startsWith('<'))) reach.limitTicked++;
          if (allRows(v).some((row) => row.ticked && row.ref[0] === 'a' && row.label === 'LDL Cholesterol')) reach.labAsCore++;
          if (run.s.files.some((f) => f.status.s === 'read' && Object.keys(f.status.choices.edits).length)) reach.edited++;
        }
      }
    }
    if (process.env.UPLOAD_VIEW_PROPERTY_OUT) writeFileSync(process.env.UPLOAD_VIEW_PROPERTY_OUT, JSON.stringify({ reach, gaps: Object.fromEntries(Object.entries(gaps).map(([k, v]) => [k, { seqs: v.length, first: v.slice(0, 5) }])) }, null, 1));
    expect(reach.steps).toBeGreaterThan(20000);
    for (const [name, k] of Object.entries(reach)) expect([name, k > 0]).toEqual([name, true]);
  }, 60_000);
});

