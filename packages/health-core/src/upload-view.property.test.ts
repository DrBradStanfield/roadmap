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
 * The web list's engine half (web list PR 1a), each with an oracle that never reads what the view computed, and the
 * mutation each was shown failing on before it passed:
 *   K1 a day change keeps each day control's key, and moves only its own source's rows (a test day may also take or give
 *      back a previous column's day, by the before-the-test rule). Mutation: the test-day control's key holding the day
 *      picked (`key: \`${f.fileId}|test|${chosen}\``).
 *   B  Save's blockers are what the extraction and choices make them: a ticked value with no day waits at its source's
 *      control, a ticked row with an error at its row; each names a row or control the view draws; Save is enabled only
 *      with none. Two KNOWN pins of main's own, for 1b (upload-view.gaps.test.ts): columnBlockerUndrawn (a waiting dated
 *      column's day has no control yet) and copyBlocksWithoutError. Mutation: the test-day blocker keyed at the previous
 *      column's control.
 *   K4 while saving, a row drawn as saving is one the press promised (`reviewed`), matched by (file, ref); outside saving,
 *      `saves` is what the row shows ticked and writable (P2). Mutation: `saves` ignoring `reviewed`.
 *   P7 also: a written row's `shown` number, read back in the person's unit, is what Save writes (web; the phone gets none).
 * The web list's ledger (web list PR 1b, upload-list.test-helpers.ts names each mutation): L1 every offered value is a row,
 *   once, in order, under its printed day, and a choice never changes the rows; L2 each row shows the choices; L3 held text
 *   blocks Save and `uploadSave` refuses; L4 one quantity, the candidate, gives the error and the blocker; L5 no silent
 *   non-write; L6 the repeat-Save probe runs after every Save (on a record another writer changed, it must not refuse).
 *   B now reads the blockers from the candidate (no KNOWN case left): mutation, the column blocker kept for a value
 *   refused on any day (`needsColumnDay = ticked.some((v) => v.waits)`), fails it.
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
import { rangeFault, reportedToCanonical, UNIT_DEFS, type MetricType } from './units';
import { PRESSURE_ORDER } from './validation';
import { createEmptyFile, type FileLabValue, type FileMeasurement, type RoadmapFile } from './roadmap-file';
import type { ChoiceChange, FileChoices } from './upload-choices';
import { initialUpload, inFlight, transition, type PickedFile, type UploadEvent, type UploadState } from './upload-flow';
import { uploadSavePlan } from './upload-plan';
import { lostReplaces, reviewedWrites, uploadReview, type UploadReview } from './upload-review';
import { requestFlags, type UploadPlatform } from './upload-rules';
import { uploadSave, type UploadSaveIO } from './upload-save';
import { uploadView, type UploadView, type ValueRow } from './upload-view';
import { uploadList, type UploadList } from './upload-list';
import { checkExistence, checkInputKind, checkInputs, checkKeysKept, checkNoSilentNonWrite, checkOneQuantity, checkTypedBlocks, holdsText, keepInputs, type PersonInputs } from './upload-list.test-helpers';
import type { TypedText } from './upload-choices';
import { FIX_ERRORS_TEXT, UPLOAD_TEXT } from './upload-text';
import { IMPORT_REVIEW_TEXT, importRow, isOfferedRef, offeredValues, PROBE_DAY, valueAt } from './import-review';
import { cellLabel, cellRange, cellToSI } from './cell-unit';
import type { UnitSystem } from './units';

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

/** `failWrites`: files whose original the cloud refuses (an unstored original). `platform`: the device the run is on.
 *  `system`: the units the person reads core values in, given to the web's view only (the phone passes none). */
interface Setup { extractions: Record<string, UnifiedExtractionResult>; record: RoadmapFile; cloud: boolean; failWrites: string[]; platform: UploadPlatform; system: UnitSystem }

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
    const kind = pick(['ldl', 'hba1c', 'ldlQ', 'ldlGuess', 'ldlHigh', 'ferritin', 'refusedAlone', 'bp', 'ldlLimit', 'ldlAsLab', 'ldlMgdl', 'unknownCore'] as const);
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
    // A core metric this build does not know (the schema takes any text): the write refuses it alone (round one, F1).
    if (kind === 'unknownCore') values.push(core({ metric: 'vitamin_zz', valueSI: 12, displayValue: 12, displayUnit: 'zz/L', ...day }));
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
function shownWritable(view: UploadView, review: UploadReview, s: UploadState): Set<string> {
  const waiting = new Set(review.labFiles.filter((f) => f.needsDay).map((f) => f.fileId));
  const out = new Set<string>();
  for (const row of allRows(view)) {
    if (!row.ticked || row.error || row.copy || row.reasons.includes('outOfRange') || waiting.has(row.fileId)) continue;
    // `uploadView` is the phone's, which never holds typed text (PHONE_STATE); the web draws `uploadList`, whose L5 checks
    // a row holding text with no exemption.
    if (heldAt(s, row.fileId, row.ref)) continue;
    if (row.conflict !== null && !row.replacing) continue;
    out.add(key(row.fileId, row.ref));
  }
  return out;
}
const heldAt = (s: UploadState, fileId: string, ref: string) => ('files' in s ? s.files : []).some((f) => f.id === fileId && f.status.s === 'read' && f.status.choices.typed?.[ref] !== undefined);
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

/** P1, P2 (same record), P3, P4, B on one view, in the person's units on the web. `note`: a known gap seen. */
function checkView(s: UploadState, record: RoadmapFile, setup: Setup, note: Note, inputs: PersonInputs): { view: UploadView; review: UploadReview; list: UploadList } {
  const { cloud } = setup;
  const review = uploadReview(s, record, NOW);
  const view = uploadView(s, record, NOW, review, cloud, unitsOf(setup));
  // The web's list, in the person's units; checked on both platforms' states, though only the web draws it.
  const unitOf = () => setup.system;
  const list = uploadList(s, record, NOW, review, unitOf);
  checkText(view);
  checkText(list as unknown as UploadView);
  checkExistence(s, review, list, fail);
  checkInputs(s, review, list, inputs, fail);
  checkTypedBlocks(s, view, inputs, fail);
  checkInputKind(s, review, list, NOW, fail);
  checkOneQuantity(s, review, view, list, unitOf, fail);
  checkNoSilentNonWrite(s, review, list, fail);
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
        // The web draws the list, where every value is a row under its day control (L1): a waiting value it unticked, or
        // one whose dated column waits for its pick (US-13 AC24), need no section of the phone's view.
        if (setup.platform === 'web') continue;
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
  const shown = shownWritable(view, review, s);
  const writes = written(review);
  const plan = uploadSavePlan(s, record, NOW, review, cloud);
  if (plan.labRows.flatMap((x) => x.rows).length !== writes.size) fail('P2', 'plan rows != written values');
  for (const k of writes) if (!shown.has(k)) fail('P2', `${k} is written but not shown ticked and writable`);
  // `saves` is what the row shows: ticked and writable (K4 checks it while saving, when no view is checked here).
  for (const row of rows) if (row.saves !== shown.has(key(row.fileId, row.ref))) fail('P2', `${row.fileId} ${row.ref} saves ${row.saves}, shown writable ${!row.saves}`);
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
  checkNumbers(s, review, rows, writes, record, setup);
  checkOracles(s, review, record);
  checkBlockers(s, view, review, list, plan);
  // P4: a disabled Save with nothing in flight names a blocker the view lets the person clear.
  if ((s.phase === 'open' || s.phase === 'saveFailed') && !view.save.enabled && inFlight(s) === 0) {
    const why = view.save.why;
    if (!why) fail('P4', 'disabled with no reason');
    if (why === FIX_ERRORS_TEXT) {
      // The rows that block, as the list draws them (the phone's view draws a sent one's error, not a copy's: main's rule).
      const errs = list.rows.filter((row) => row.status.kind === 'error');
      if (!errs.length) fail('P4', 'fix errors, but no row blocks');
      for (const row of errs) {
        const after = transition(s, { type: 'chose', id: row.fileId, change: { tick: row.ref, on: false }, now: NOW }).state;
        const again = uploadReview(after, record, NOW);
        if (uploadList(after, record, NOW, again, unitOf).rows.some((x) => x.key === row.key && x.status.kind === 'error')) fail('P4', `unticking ${row.ref} leaves its block`);
      }
    } else if (why === UPLOAD_TEXT.chooseDay) {
      for (const lf of review.labFiles.filter((f) => f.needsDay)) {
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
  return { view, review, list };
}

/**
 * P7: each row Save writes shows what Save writes: its number (an edit as typed; else as printed, whose SI
 * conversion is what a core value stores), its unit, its day; a Replace shows the value it replaces.
 */
function checkNumbers(s: UploadState, review: UploadReview, rows: ValueRow[], writes: Set<string>, record: RoadmapFile, setup: Setup) {
  const planned = new Map(review.classification.values.filter((v) => v.sent && v.writes).map((v, k) => [key(review.labFiles[v.file].fileId, v.ref), review.classification.rows[k]]));
  const reads = new Map(('files' in s ? s.files : []).flatMap((f) => (f.status.s === 'read' ? [[f.id, f.status] as const] : [])));
  for (const row of rows) {
    const k = key(row.fileId, row.ref);
    // The phone's view is given no units: its rows carry no `shown`, as before.
    if (setup.platform === 'phone' && row.shown !== undefined) fail('P7', `${k} has a shown value on the phone`);
    const bulk = planned.get(k);
    if (!writes.has(k) || !bulk) continue;
    const edit = reads.get(row.fileId)?.choices.edits[row.ref];
    const shown = Number((row.value ?? '').replace(/^[<>]=?\s*/, ''));
    if (row.day !== bulk.recordedAt.slice(0, 10)) fail('P7', `${k} shows day ${row.day}, Save writes ${bulk.recordedAt}`);
    if (setup.platform === 'web') checkShown(k, row, bulk, setup.system);
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

/** P7 in the person's unit (the web's): a written row's `shown` number, read back from that unit, is what Save writes, to the place shown. */
function checkShown(k: string, row: ValueRow, bulk: BulkRow, system: UnitSystem) {
  const own = row.shown;
  if (!own) return fail('P7', `${k} has no shown value`);
  if (bulk.kind === 'lab') {
    if (Number(own.number) !== bulk.value || own.unit !== bulk.unit) fail('P7', `${k} shows ${own.number} ${own.unit}, Save writes ${bulk.value} ${bulk.unit}`);
    return;
  }
  const metric = bulk.metricType as MetricType;
  if (own.unit !== cellLabel(metric, system)) fail('P7', `${k} shown in ${own.unit}, the person reads ${cellLabel(metric, system)}`);
  // Within half a step of the last place shown (display rounding), read back in SI.
  const n = Number(own.number);
  const back = cellToSI(metric, n, system);
  const step = 0.5 * 10 ** -((own.number.split('.')[1] ?? '').length);
  if (Math.abs(back - bulk.value) > Math.abs(cellToSI(metric, n + step, system) - back) + 1e-9) fail('P7', `${k} shows ${own.number} ${own.unit} (${back} SI), Save writes ${bulk.value}`);
}

/** A value's day source as its control's key, from the day it printed alone (never the view's `dayKey`). */
function sourceKey(fileId: string, x: UnifiedExtractionResult, ref: string): string {
  const printed = valueAt(x, ref)?.value.recordedAt;
  return `${fileId}|${printed === undefined ? 'test' : printed === UNDATED_PREVIOUS ? 'previous' : `printed:${printed}`}`;
}

/** The write refuses this value whatever its day (a lab's unit or number), as Save would send it: it asks no day. */
function refusedAnyDay(st: { extraction: UnifiedExtractionResult; choices: FileChoices }, ref: string): boolean {
  const edit = st.choices.edits[ref];
  const row = importRow(st.extraction, ref, PROBE_DAY, edit !== undefined ? { edited: { value: edit } } : {});
  return !!row && bulkAppendValues(createEmptyFile({ deviceId: 'oracle', now: NOW }), [row], NOW).refused.length > 0;
}

/**
 * B: Save's blockers, from the extraction, the choices and the units table (and, for a kept conflict or a blood pressure
 * pair, the review): a ticked value with no day waits at its source's control (the test's and a dated column's never for
 * a value the write refuses on any day); a row blocks at itself when it holds text, or is ticked, selected and faulty
 * (L4's fault, sent or not). Each names a row or a day control the list draws, once. Save is enabled only with none, and
 * says the first. Mutations that fail it: the test-day blocker keyed at the previous column's control; the column blocker
 * kept for a value refused on any day.
 */
function checkBlockers(s: UploadState, view: UploadView, review: UploadReview, list: UploadList, plan: ReturnType<typeof uploadSavePlan>) {
  const { blockers } = view.save;
  if (s.phase !== 'open' && s.phase !== 'saveFailed') { if (blockers.length) fail('B', `${blockers.length} blockers while ${s.phase}`); return; }
  const days = new Set<string>();
  const fixes = new Set<string>();
  const classified = new Map(review.classification.values.map((v) => [`${review.labFiles[v.file].fileId}:${v.ref}`, v]));
  for (const f of s.files) {
    if (f.status.s !== 'read' || f.status.extraction.classification !== 'lab_report') continue;
    const st = f.status;
    for (const at of offeredValues(st.extraction)) {
      const { ref } = at;
      const ticked = st.choices.ticks[ref] ?? true;
      const v = classified.get(`${f.id}:${ref}`)!;
      const typed = st.choices.typed?.[ref] !== undefined;
      const metric = at.kind === 'core' && Object.prototype.hasOwnProperty.call(UNIT_DEFS, at.value.metric) ? at.value.metric as MetricType : null;
      const pairOrUnknown = at.kind === 'core' && !metric;
      const candidate = st.choices.edits[ref] ?? (at.kind === 'core' ? at.value.valueSI : at.value.value);
      const pair = v.sent && !v.writes && v.group === 'unsure' && v.reasons.includes('outOfRange');
      const fault = (!!metric && (!!rangeFault(cellRange(metric, 'si'), candidate) || pair)) || (pairOrUnknown && pair);
      const kept = v.group === 'unsure' && v.reasons.includes('conflict') && (!!v.copy || !review.labFiles.find((l) => l.fileId === f.id)!.replacing.includes(ref));
      const future = v.group === 'notSaved' && (v.reason === 'futureDay' || v.reason === 'futureCoreDay');
      if (typed || (ticked && fault && !kept && !future)) fixes.add(`${f.id}:${ref}`);
      if (!ticked || expectedDay(st, ref).day !== null) continue;
      // The undated previous column waits for any ticked value (main's rule); the test's and a dated column's never for a
      // value the write refuses whatever its day (it sits under Not saved).
      const src = sourceKey(f.id, st.extraction, ref);
      if (src.endsWith('|previous') || !refusedAnyDay(st, ref)) days.add(src);
    }
  }
  const want = [...fixes, ...days].sort();
  const got = blockers.map((b) => b.at).sort();
  if (JSON.stringify(got) !== JSON.stringify(want)) fail('B', `blockers at ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  // A report that writes nothing while it waits for a day holds Save at one of its day controls: never a silent skip.
  for (const lf of review.labFiles) if (lf.needsDay && !got.some((at) => at.startsWith(`${lf.fileId}|`))) fail('B', `${lf.fileId} waits for a day and Save does not`);
  const controls = new Set([...list.rows.map((r) => r.key), ...list.days.map((d) => d.key)]);
  for (const b of blockers) {
    const wantWhy = fixes.has(b.at) ? FIX_ERRORS_TEXT : UPLOAD_TEXT.chooseDay;
    if (b.why !== wantWhy) fail('B', `blocker at ${b.at} says "${b.why}"`);
    if (!controls.has(b.at)) fail('B', `blocker at ${b.at}, which the list does not draw`);
  }
  if (blockers.length && view.save.enabled) fail('B', 'Save enabled with a blocker');
  if (blockers.length && inFlight(s) === 0 && view.save.why !== blockers[0].why) fail('B', `why "${view.save.why}" is not the first blocker`);
  // With none, Save is on, or there is nothing to save (`planIsEmpty`).
  const nothing = plan.counts.values + plan.counts.documents + plan.counts.originals === 0;
  if (!blockers.length && inFlight(s) === 0 && !view.save.enabled && !(view.save.why === UPLOAD_TEXT.saveNothing && nothing)) fail('B', `Save off with no blocker: ${view.save.why}`);
}

/** A day change the list's date input can send: a whole day (it ignores an emptied input and never sends part of one). */
const fullDayChange = (c: ChoiceChange) => {
  const day = 'testDay' in c ? c.testDay : 'previousDay' in c ? c.previousDay : 'columnDay' in c ? c.day : undefined;
  return typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day);
};

/**
 * K1: a day change keeps each day control's key: before and after, and always the one its kind and file name (never the
 * day). In its file it moves only its own source's rows, but a test day may also take or give back a previous column's
 * day (its pick must be before the test's: the row's day becomes none, or its pick); no other file's row moves.
 * Mutation that fails it: the test-day control's key holding the day picked.
 */
function checkDayChange(before: UploadView, after: UploadView, s: UploadState, e: Extract<UploadEvent, { type: 'chose' }>) {
  const keys = (v: UploadView) => new Map(v.sections.flatMap((x) => ('key' in x ? [[`${x.kind} ${x.fileId}`, x.key] as const] : [])));
  const was = keys(before);
  for (const [id, k] of keys(after)) {
    const [kind, fileId] = id.split(' ');
    if (k !== `${fileId}|${kind === 'undated' ? 'test' : 'previous'}`) fail('K1', `${id}'s control is keyed ${k}`);
    if (was.has(id) && was.get(id) !== k) fail('K1', `${id}'s control was ${was.get(id)}, now ${k}`);
  }
  const change = e.change;
  const source = 'testDay' in change ? 'test' : 'previousDay' in change ? 'previous' : 'columnDay' in change ? `printed:${change.columnDay}` : null;
  const day = new Map(allRows(before).map((r) => [key(r.fileId, r.ref), r.day]));
  for (const row of allRows(after)) {
    const k = key(row.fileId, row.ref);
    if (!day.has(k) || day.get(k) === row.day) continue;
    const st = 'files' in s ? s.files.find((f) => f.id === row.fileId)?.status : undefined;
    if (st?.s !== 'read') continue;
    const own = sourceKey(row.fileId, st.extraction, row.ref);
    if (row.fileId === e.id && own === `${e.id}|${source}`) continue;
    // The before-the-test rule: a previous column's row loses its day, or gets its pick back, when the test's day moves.
    const printed = valueAt(st.extraction, row.ref)?.value.recordedAt;
    const pick = printed === UNDATED_PREVIOUS ? st.choices.previousDay : st.choices.columnDays?.[printed ?? ''];
    if (row.fileId === e.id && source === 'test' && !own.endsWith('|test') && (row.day === null || row.day === validDay(pick ?? undefined, { now: NOW })?.slice(0, 10))) continue;
    fail('K1', `a ${source} day change in ${e.id} moved ${k} (${own}) from ${day.get(k)} to ${row.day}`);
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
  // A value is judged on the number Save would send, its edit included; one not sent too, on the web alone (import-review
  // step 3; owner ruling 2026-11-21: the phone's preview reads the number read, KNOWN phoneEditPreview).
  const facts = (fi: number, ref: string, sent = true) => {
    const lf = review.labFiles[fi];
    const st = reads.get(lf.fileId)!;
    const x = st.extraction;
    const printed = valueAt(x, ref)?.value;
    const own = printed?.recordedAt === UNDATED_PREVIOUS ? undefined : printed?.recordedAt;
    const { day } = expectedDay(st, ref);
    const edit = st.choices.edits[ref];
    const row = day ? importRow(x, ref, day, edit !== undefined && (sent || s.platform === 'web') ? { edited: { value: edit } } : {}) : null;
    return { printed, own, row, slot: row ? slotKey(bulkRowTarget(row).slot, bulkRowTarget(row).metric, row.recordedAt) : null };
  };
  const values = review.classification.values;
  for (const v of values) {
    if (v.ref[0] === 'r') { if (v.group !== 'notSaved' || v.reason !== 'noUnit') fail('O', `${v.ref} refused row is ${v.group}`); continue; }
    if (!isOfferedRef(v.ref)) continue;
    // A value whose dated column waits for its pick has no day (US-13 AC24): it is never written, and judged on no day.
    if (expectedDay(reads.get(review.labFiles[v.file].fileId)!, v.ref).waits) { if (v.sent && v.writes) fail('O', `${v.ref} waits for its column's day and is written`); continue; }
    const f = facts(v.file, v.ref, v.sent);
    if (v.group === 'saved') {
      if (!f.row || !f.slot) fail('O', `${v.ref} saved with no day`);
      const equal = (value: number) => Math.abs(value - f.row!.value) < 1e-9;
      const inRecord = held.some((h) => slotOfRow(h) === f.slot && equal(h.value) && (h.comparator ?? null) === (f.row!.comparator ?? null));
      // A winner holding typed text keeps its slot but is not written (web list PR 1b); Save is blocked meanwhile.
      const holds = (o: { file: number; ref: string }) => heldAt(s, review.labFiles[o.file].fileId, o.ref);
      const sibling = 'duplicate' in v && v.duplicate && values.some((o) => o !== v && o.sent && (o.writes || o.group === 'saved' || holds(o)) && facts(o.file, o.ref).slot === f.slot && facts(o.file, o.ref).row && equal(facts(o.file, o.ref).row!.value));
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
  last: { view: UploadView; review: UploadReview; list: UploadList; record: RoadmapFile } | null = null;
  /** Rows the last commit wrote as corrections (Replace). */
  corrections = 0;
  /** The last step's view came after the door dropped a lost Replace. */
  lostReplace = false;
  /** The last commit's facts, for the reach counts: values skipped, originals unstored, originals filed behind a held row. */
  saved = { skipped: 0, unstored: 0, archiveOnly: 0 };
  constructor(readonly setup: Setup, readonly note: Note) { this.record = setup.record; this.s = initialUpload(setup.platform); }

  /** Day changes K1 compared; saving pages K4 checked with a row written now that was never promised. */
  k1 = 0;
  k4 = 0;
  /** Saves refused for held text (L3). */
  typedRefused = 0;
  /** What the person entered in each row, logged from their own events (L7). */
  inputs = new Map<string, { typed: TypedText | null; edit: number | undefined }>();

  async apply(step: Step): Promise<void> {
    const before = this.last?.view;
    const listBefore = this.last?.list;
    const phaseBefore = this.s.phase;
    const dayChange = step.type === 'event' && step.e.type === 'chose' && fullDayChange(step.e.change) ? step.e : null;
    await this.step(step);
    if (this.s.phase === 'saving') this.checkSaving();
    const open = (phase: UploadState['phase']) => phase === 'open' || phase === 'saveFailed';
    if (dayChange && before && this.last && open(phaseBefore) && open(this.s.phase)) { checkDayChange(before, this.last.view, this.s, dayChange); this.k1++; }
    // L1: a choice never adds, drops or moves a row.
    if (step.type === 'event' && step.e.type === 'chose' && listBefore && this.last && open(phaseBefore) && open(this.s.phase)) checkKeysKept(listBefore, this.last.list, fail);
    // L3: with text held anywhere, Save as the platform runs it refuses, writing nothing.
    if (this.s.phase === 'open' && holdsText(this.s)) {
      // Forced into saving past the machine (which starts no Save while a file is in flight), as a stale tap could be.
      const saving: UploadState = { ...this.s, phase: 'saving', attempt: 1, reviewed: this.last?.view.reviewed };
      const out = await uploadSave(saving, this.record, NOW, this.setup.cloud, io(this.setup.cloud));
      if (out.ok || out.reason !== 'not-ready') fail('L3', `uploadSave with held text answered ${out.ok ? 'ok' : out.reason}`);
      this.typedRefused++;
    }
  }

  /**
   * K4: while saving, the page drawn on the record as it is now shows as saving only what the press promised (`reviewed`),
   * matched by (file, ref). Mutation that fails it: `saves` ignoring `reviewed` (sent and written alone).
   */
  private checkSaving() {
    if (this.s.phase !== 'saving' || !this.s.reviewed) return;
    const promised = new Set(this.s.reviewed.map((v) => key(v.file, v.ref)));
    const review = uploadReview(this.s, this.record, NOW);
    const view = uploadView(this.s, this.record, NOW, review, this.setup.cloud, unitsOf(this.setup));
    // A drawn row the record now lets Save write that the press never promised: where `saves` must read `reviewed`.
    if (allRows(view).some((row) => written(review).has(key(row.fileId, row.ref)) && !promised.has(key(row.fileId, row.ref)))) this.k4++;
    const extra = allRows(view).filter((row) => row.saves && !promised.has(key(row.fileId, row.ref)));
    if (extra.length) fail('K4', `drawn as saving but never promised: ${extra.map((row) => key(row.fileId, row.ref)).join(', ')}`);
    if (allRows(view).some((row) => !row.saves && promised.has(key(row.fileId, row.ref)))) this.note('promisedNoLongerWrites');
  }

  private async step(step: Step): Promise<void> {
    // The engine door drops a Replace whose target left its slot before each event and in each view (replacesLost).
    if (step.type === 'event') this.s = doorState(this.s, this.record);
    const takesChoices = this.s.phase === 'open' || this.s.phase === 'saveFailed';
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
    const ch = step.type === 'event' && step.e.type === 'chose' ? step.e : null;
    // The machine takes a choice only open or after a failed Save (upload-flow.ts 'chose'); L7 logs the expected effect then.
    keepInputs(this.s, this.inputs, ch ? { id: ch.id, change: ch.change, taken: takesChoices } : null, fail);
    if (this.s.phase === 'done' || this.s.phase === 'saving') return;
    if (this.s.phase === 'open' || this.s.phase === 'saveFailed') {
      const door = doorState(this.s, this.record);
      this.lostReplace = door !== this.s;
      this.s = door;
    }
    // The door's own step (a lost Replace dropped) is not the person's: L7 checks it too.
    keepInputs(this.s, this.inputs, null, fail);
    const { view, review, list } = checkView(this.s, this.record, this.setup, this.note, this.inputs);
    this.last = { view, review, list, record: this.record };
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
    // P5, L6: a repeat Save on the committed record runs after every Save, held text or not. Where no other writer acted it
    // never refuses and adds nothing. Where one did, it may refuse only as the view would (a pressure half now the wrong way
    // up), and a value the first Save counted as skipped, its slot taken then freed, is one the page did promise.
    const quiet = seen?.record === atSave && atSave === atCommit;
    const again = await uploadSave(this.s, file, NOW, this.setup.cloud, io(this.setup.cloud, this.setup.failWrites));
    if (!again.ok && (quiet || again.reason !== 'not-ready')) fail('L6', `repeat Save refused: ${again.message}`);
    if (again.ok && quiet) {
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
    // US-14 AC13: originals kept and nothing else written heads with the kept line alone.
    const keptOnly = outcome.archived > 0 && !outcome.values && !outcome.documents;
    if (done.done?.line !== (keptOnly ? UPLOAD_TEXT.archivedLine(outcome.archived) : UPLOAD_TEXT.savedLine(outcome.values, outcome.documents))) fail('P3', 'done line');
    if (done.done?.archived !== (outcome.archived && !keptOnly ? UPLOAD_TEXT.archivedLine(outcome.archived) : null)) fail('P3', 'done kept line');
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
    // Sometimes every file has one name (a phone's "IMG_0001.jpg" twice): ids, never names, key the rows.
    const same = coin(0.15);
    const files: PickedFile[] = Array.from({ length: n }, (_, i) => ({ id: `f${i}`, name: same ? 'report.pdf' : `report-${i}.pdf`, bytes: 1, kind: 'file', ...(coin(0.25) ? { original: false as const } : {}) }));
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
    const shown = run.last ? surface(run) : [];
    const row = shown.find((x) => x.blocks) ?? (shown.length && coin(0.3) ? pick(shown) : undefined);
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
    const err = surface(run).find((row) => row.blocks);
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
  const rows = surface(run).filter((row) => row.fileId === fileId);
  const asksDay = view.sections.some((x) => x.kind === 'undated' && x.fileId === fileId);
  // The phone's pickers offer only days up to today (UploadReviewView.swift `in: ...Date.now`, DayCalendar).
  if (asksDay && (!rows.length || coin(0.4))) return { testDay: pick([PICKED_DAY, DAY, PAST]) };
  const printsUndated = [...(f.status.extraction.values ?? []), ...(f.status.extraction.additionalValues ?? [])].some((x) => x.recordedAt === UNDATED_PREVIOUS);
  if (printsUndated && coin(0.3)) return { previousDay: pick([EARLY, PAST, PICKED_DAY, DAY, '2026-10', null]) };
  // A dated previous column's day, on the web only (US-13 AC24): a valid early day, a partial pick that waits, another column's
  // printed day, or a real day on or after the test's (DAY, PICKED_DAY: it waits, PR 1926 R1).
  const columns = printedDays(f.status.extraction);
  if (run.setup.platform === 'web' && columns.length && coin(0.25)) {
    const columnDay = pick(columns);
    const others = columns.filter((d) => d !== columnDay);
    return { columnDay, day: pick([EARLY, '2026-10', DAY, PICKED_DAY, ...(others.length ? [pick(others)] : [])]) };
  }
  if (!rows.length) return null;
  const row = pick(rows);
  const k = r();
  // Sometimes a tick on a ticked row that holds text (a tap on a checked box): it must keep the text (L7).
  if (k < 0.45) return { tick: row.ref, on: !row.ticked || (k < 0.15 && !!row.typed) };
  if (k < 0.75) {
    if (row.replacing) return { replace: row.ref, correctsId: null };
    const stale = rowsOf(run.record).filter((x) => !isActive(x)).map((x) => x.id);
    const correctsId = row.replaces && coin(0.8) ? row.replaces : stale.length ? pick(stale) : 'no-such-row';
    return row.replaces || coin(0.2) ? { replace: row.ref, correctsId } : { tick: row.ref, on: !row.ticked };
  }
  // Text typed into a row, on the web (US-13 AC12): a number, one the cells question, one that is no number, or nothing.
  if (run.setup.platform === 'web' && coin(0.5)) {
    const at = valueAt(f.status.extraction, row.ref);
    // Mostly the unit the person reads; sometimes one that does not fit the value (round one, F3: refused, never a throw).
    const unit = coin(0.15) ? pick(['nmol/L', 'mg/L', 'mg/dL', 'si', null] as const) : at?.kind === 'core' ? run.setup.system : null;
    return { typed: row.ref, text: pick(['abc', '3..5', '1,234', '3.6', '12.9', '500', '', '3.14']), unit };
  }
  return { edit: row.ref, value: pick([2.0, 3.1, 52, 500, null, Number.NaN]) };
}

/** The rows the platform draws, as a person acts on them: the web's list, the phone's view. `blocks`: it holds up Save. */
function surface(run: Run): Array<{ fileId: string; ref: string; ticked: boolean; replaces: string | null; replacing: boolean; blocks: boolean; typed: TypedText | null }> {
  if (!run.last) return [];
  if (run.setup.platform === 'web') return run.last.list.rows.map((r) => ({ ...r, blocks: r.status.kind === 'error' }));
  return allRows(run.last.view).map((r) => ({ ...r, blocks: !!r.error && r.ticked, typed: null }));
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

/** `system` is given, not drawn, so every seed draws the same values as before it was added. */
function genSetup(r: () => number, system: UnitSystem): Setup {
  const extractions: Record<string, UnifiedExtractionResult> = {};
  const platform: UploadPlatform = r() < 0.5 ? 'web' : 'phone';
  for (let i = 0; i < 3; i++) extractions[`f${i}`] = r() < 0.75 ? genLab(r, platform) : genLetter(r);
  return { extractions, record: genRecord(r), cloud: r() < 0.5, failWrites: r() < 0.2 ? ['f0'] : [], platform, system };
}

/** The person's units, as the web's view takes them; the phone's view gets none. */
const unitsOf = (setup: Setup) => (setup.platform === 'web' ? () => setup.system : undefined);

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

/** A lab file waiting on a column whose pick is a real past day, but not before the test's day (US-13 AC24). */
const waitsNotBefore = (review: UploadReview, s: UploadState) => review.labFiles.some((lf) => {
  const f = 'files' in s ? s.files.find((x) => x.id === lf.fileId) : undefined;
  if (f?.status.s !== 'read') return false;
  const { extraction, choices } = f.status;
  return lf.waits.some((ref) => {
    const pick = validDay(choices.columnDays?.[valueRecordedAt(extraction, ref) ?? ''] ?? undefined, { now: NOW })?.slice(0, 10);
    return !!pick && !!lf.day && pick >= lf.day.slice(0, 10);
  });
});

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
      merges: 0, replaceLost: 0, changedBeforeTap: 0, freedBeforeCommit: 0, skipped: 0, unstored: 0, archiveOnly: 0, copies: 0, alreadySaved: 0, futureDay: 0, undatedPrevious: 0, pressureRefused: 0, limitTicked: 0, labAsCore: 0, edited: 0, noOriginalSaved: 0, columnMoved: 0, columnNotBefore: 0,
      k1DayChanges: 0, k4Unpromised: 0, conventionalShown: 0, blockedAtColumn: 0, blockedAtRowAndDay: 0,
      typedRefused: 0, typedSavedAfter: 0, sameNamed: 0, listAlreadyInRecord: 0, listWaits: 0, listSameDayTicked: 0, listCopyError: 0, unsentBlocked: 0, tickOnHeld: 0, inputNone: 0,
    };
    for (let seed = 1; seed <= SEEDS; seed++) {
      const r = mulberry32(seed);
      const setup = genSetup(r, seed % 2 ? 'si' : 'conventional');
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
        const lastView = run.last?.view;
        if (lastView && run.setup.system === 'conventional' && allRows(lastView).some((row) => row.shown?.unit === 'mg/dL')) reach.conventionalShown++;
        if (lastView?.save.blockers.some((b) => b.at.includes('|printed:'))) reach.blockedAtColumn++;
        if (lastView && lastView.save.blockers.some((b) => b.why === FIX_ERRORS_TEXT) && lastView.save.blockers.some((b) => b.why === UPLOAD_TEXT.chooseDay)) reach.blockedAtRowAndDay++;
        if (step.type === 'save' && run.s.phase === 'done') reach.corrections += run.corrections;
        // A dated previous column's value moved by its pick, drawn to be written on the page Save ran from and saved (P7 checked its day).
        if (step.type === 'save' && run.s.phase === 'done' && run.last && movedColumn(run.last.view, run.last.review, run.s)) reach.columnMoved++;
        if (run.s.phase === 'done') { reach.saved++; if (phase.saves) reach.saveFailedThenSaved++; if (run.s.files.some((f) => f.original === false)) reach.noOriginalSaved++; }
        if (step.type === 'save' && step.meanwhile) reach.changedBeforeSave++;
        // A tick on a row holding text, which keeps it (L7); a row whose input takes no typing (L8).
        if (step.type === 'event' && step.e.type === 'chose' && 'tick' in step.e.change && step.e.change.on && run.inputs.get(`${step.e.id}:${step.e.change.tick}`)?.typed) reach.tickOnHeld++;
        if (run.last?.list.rows.some((row) => row.input === 'none')) reach.inputNone++;
        if (step.type === 'tap') reach.changedBeforeTap++;
        if (step.type === 'save' && step.free) reach.freedBeforeCommit++;
        if ((step.type === 'record' || (step.type === 'save' && step.meanwhile)) && step.merge) reach.merges++;
        if (step.type === 'delete' && lostBefore(run)) reach.replaceLost++;
        if (step.type === 'save' && run.s.phase === 'done') { reach.skipped += run.saved.skipped; reach.unstored += run.saved.unstored; reach.archiveOnly += run.saved.archiveOnly; }
        const v = run.last?.view;
        const list = run.last?.list;
        if (list && run.s.phase === 'open') {
          if ('files' in run.s && new Set(run.s.files.map((f) => f.name)).size < run.s.files.length && list.rows.length) reach.sameNamed++;
          if (list.rows.some((r) => r.status.kind === 'alreadyInRecord')) reach.listAlreadyInRecord++;
          if (list.rows.some((r) => r.status.kind === 'waits')) reach.listWaits++;
          if (list.rows.some((r) => r.status.kind === 'sameDay' && r.ticked)) reach.listSameDayTicked++;
          if (list.rows.some((r) => r.status.kind === 'error' && r.error !== null && !allRows(v!).some((x) => x.fileId === r.fileId && x.ref === r.ref && x.error))) reach.listCopyError++;
          if (v?.save.blockers.some((b) => b.why === FIX_ERRORS_TEXT && run.last!.review.classification.values.some((c) => !c.sent && `${run.last!.review.labFiles[c.file].fileId}:${c.ref}` === b.at))) reach.unsentBlocked++;
        }
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
          // A column that waits because its pick, a real past day, is not before the test's day (P8 checks the wait).
          if (run.last && waitsNotBefore(run.last.review, run.s)) reach.columnNotBefore++;
          // A value of the undated previous column on a picked day, shown to be written (P7 checks its day).
          if (allRows(v).some((row) => run.last?.view.reviewed?.some((w) => w.file === row.fileId && w.ref === row.ref) && run.s.phase === 'open' && run.s.files.some((f) => f.id === row.fileId && f.status.s === 'read' && valueRecordedAt(f.status.extraction, row.ref) === UNDATED_PREVIOUS))) reach.undatedPrevious++;
        }
      }
      reach.k1DayChanges += run.k1;
      reach.k4Unpromised += run.k4;
      reach.typedRefused += run.typedRefused;
      if (run.typedRefused && run.s.phase === 'done') reach.typedSavedAfter++;
    }
    if (process.env.UPLOAD_VIEW_PROPERTY_OUT) writeFileSync(process.env.UPLOAD_VIEW_PROPERTY_OUT, JSON.stringify({ reach, gaps: Object.fromEntries(Object.entries(gaps).map(([k, v]) => [k, { seqs: v.length, first: v.slice(0, 5) }])) }, null, 1));
    expect(reach.steps).toBeGreaterThan(20000);
    for (const [name, k] of Object.entries(reach)) expect([name, k > 0]).toEqual([name, true]);
    // About 14 s locally; CI shards measured 22, 36, 46, 47 and 73 s (PR 1926), so 60 s failed a run.
  }, 120_000);
});

