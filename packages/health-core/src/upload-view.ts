/**
 * The upload's drawable view (design sections 1 and 4; US-52 AC8c, US-13 AC13, AC14, US-12
 * AC26 to AC28): every string resolved and every count made here, so the web and the iPhone
 * draw it and send events, and neither counts. Known files are only counted. The Save label
 * counts what the plan writes, from the same classification (upload-review.ts).
 *
 * Cost: the classification is the caller's (`uploadReview`); the view and its plan are passes
 * over the files and the classified values, linear in each, plus one scan of the record's
 * documents for held rows.
 */
import { DOCUMENT_TYPES, type DocumentType } from './validation';
import { documentKind, IMPORT_REVIEW_TEXT, isOfferedRef, KIND_WORDS, NOT_SAVED_TEXT, notSavedGroups, type ClassifiedValue, type NotSavedReason, type UnsureReason } from './import-review';
import type { FileLabValue, FileMeasurement, RoadmapFile } from './roadmap-file';
import { effectiveComparator, isReadableRow } from './readable-rows';
import { getDisplayLabel, type MetricType } from './units';
import { inFlight, RETRYABLE, saveEnabled, uploadFileName, type FileStatus, type SaveOutcome, type UploadFile, type UploadState } from './upload-flow';
import { planIsEmpty, uploadSavePlan, type UploadSavePlan } from './upload-plan';
import type { UploadPlatform } from './upload-rules';
import { readFiles, reviewedWrites, type ReviewedValue, type UploadReview } from './upload-review';
import { failLine, FILE_NOTICE_TEXT, FIX_ERRORS_TEXT, longDate, REFUSED_TEXT, REVIEW_CELL_TEXT, UNREADABLE_VALUE_TEXT, UPLOAD_TEXT } from './upload-text';
import { UNDATED_PREVIOUS, type UnifiedExtractionResult } from './lab-extraction';
import { withComparator } from './lab-limits';
import { validDay } from './record-edits';

/**
 * `ticked`: the tick shown now, ticked unless cleared. `replaces`: a conflict's held row,
 * for `ChoiceChange` replace; null when there is nothing to replace. `replacing`: the Replace
 * control is on and still aimed at that row; `conflict` then says what Save will do. `error`: a
 * selected core value Save would refuse, in the write's words; it blocks Save (US-13 AC5).
 */
export interface ValueRow {
  fileId: string; ref: string; label: string; reasons: UnsureReason[]; conflict: string | null;
  ticked: boolean; replaces: string | null; replacing: boolean; error: string | null;
  /** Added for the iPhone's page (design PR 15), additive: the value as the report printed it, its
   *  limit sign kept ("< 0.6"), and its unit; the extractor's own question (data from the read);
   *  `unitNote` when the read guessed the unit; the day it will be saved on (its own, else its
   *  report's; YYYY-MM-DD, null while the report waits for one) and that day as the web writes it;
   *  the Replace control's word and spoken name, and `held`, the value the record holds that day
   *  (number and unit as stored, or the words for a value no reader can read), when there is one. */
  value?: string; unit?: string; question?: string | null; unitNote?: string | null; day?: string | null; dayLine?: string | null;
  replace?: string | null; replaceLabel?: string | null; held?: string | null;
  /** An equal reading of this upload is on the same test and day: this one is not written, and Replace lives only on that one. */
  copy?: string | null;
}
export type UploadSection =
  /** `choose`: the button that opens the day picker; no day is assumed (design PR 15). `chosen`: the
   *  day the person picked (YYYY-MM-DD), so the section stays, showing it, to be changed. */
  | { kind: 'undated'; fileId: string; title: string; label: string; name: string; choose?: string; chosen?: string | null }
  /** An undated previous column's day (US-12 AC14; web only): a day in `month` (YYYY-MM) before
   *  `before`, when known. Its words stay in the web's ReviewTable until they move (no string yet). */
  | { kind: 'undatedPrevious'; fileId: string; name: string; month: string | null; before: string | null }
  | { kind: 'unsure'; title: string; footer: string; rows: ValueRow[] }
  | { kind: 'failed'; title: string; rows: Array<{ fileId: string; name: string; line: string }>; retry: string | null }
  | { kind: 'notSaved'; title: string; lines: string[]; footer: string };

export interface UploadView {
  /** Null once nothing is in flight. `zip`: the ZIP being opened, while one is. */
  progress: { done: number; total: number; line: string; zip: string | null } | null;
  summary: string;
  sections: UploadSection[];
  /** Hidden behind Show all. */
  sure: { line: string; showAll: string; rows: ValueRow[]; hide?: string } | null;
  /** Additive for the iPhone (design PR 15): `kinds`, each document type with its word, for the kind
   *  choice; a row's `kindKey` and machine `day` (YYYY-MM-DD, null when none); the date buttons' words. */
  documents: {
    line: string; rows: Array<{ fileId: string; title: string; kind: string; date: string; dateKnown: boolean; kindKey?: DocumentType; day?: string | null }>;
    kinds?: Array<{ key: DocumentType; word: string }>; setDate?: string; removeDate?: string;
  } | null;
  /** The collapsed "Files" list. */
  files: { row: string; rows: Array<{ fileId: string; name: string; status: string }> };
  /** Read files with nothing in them, and files read only in part, in the web's notice words (US-12 AC9). */
  notices: Array<{ fileId: string; name: string; line: string }>;
  /** `error`: a failed save's message; Save then retries. */
  save: { label: string; enabled: boolean; why: string | null; error: string | null };
  stop: { label: string } | null;
  /** The done screen's lines. `skipped`: reviewed values another writer beat to their slot (US-12 AC6a).
   *  `notSaved`: values the final commit refused, one line per reason in the review's words. */
  done: { line: string; archived: string | null; unstored: string | null; skipped: string[]; notSaved: string[] } | null;
  /** Values the record already holds, equal, on their day: counted, as the web's review counts them (ReviewTable.tsx). */
  alreadySaved?: string | null;
  /** What this page shows as to be written (upload-review `reviewedWrites`): the app sends it back, as drawn, on
   *  `saveStarted`, and Save writes nothing else (owner ruling 2026-11-20, US-13 AC23). */
  reviewed?: ReviewedValue[];
  /** Additive for the iPhone (design PR 15), so its page holds no mode: the machine's phase; a whole
   *  run's refusal in the web's words; whether Close may leave (not while saving); the word for
   *  Done and a picker's confirm. */
  phase?: UploadState['phase'];
  refused?: string | null;
  closeEnabled?: boolean;
  doneLabel?: string;
  /** The review's choices can be changed: open, or after a failed Save; never while saving. */
  editable?: boolean;
}

const READING: readonly FileStatus['s'][] = ['converting', 'sending'];
const AT_REST: readonly FileStatus['s'][] = ['known', 'refused', 'read', 'failed', 'stopped'];

function statusWords(status: FileStatus, platform: UploadPlatform): string {
  switch (status.s) {
    case 'known': return UPLOAD_TEXT.statusKnown;
    case 'refused': return UPLOAD_TEXT.statusRefused(status.verdict);
    case 'read': return UPLOAD_TEXT.statusRead;
    case 'failed': return failLine(status, platform);
    case 'stopped': return UPLOAD_TEXT.stoppedLine;
    default: return READING.includes(status.s) ? UPLOAD_TEXT.statusReading : UPLOAD_TEXT.statusWaiting;
  }
}

/** "18 files: 7 already in your record, 8 clinic letters, 3 lab reports"; all known has its own line. */
function summary(files: readonly UploadFile[], plan: UploadSavePlan, labReports: number): string {
  const known = files.filter((f) => f.status.s === 'known').length;
  if (files.length > 0 && known === files.length) return UPLOAD_TEXT.allKnown;
  const kinds = new Map<DocumentType, number>();
  for (const { fields } of plan.documents) {
    const kind = documentKind(fields.documentType);
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  }
  return UPLOAD_TEXT.summaryFiles(files.length, [
    ...(known ? [UPLOAD_TEXT.partKnown(known)] : []),
    ...DOCUMENT_TYPES.filter((k) => kinds.has(k)).map((k) => UPLOAD_TEXT.partDocuments(k, kinds.get(k)!)),
    ...(labReports ? [UPLOAD_TEXT.partLabReports(labReports)] : []),
  ]);
}

function progress(s: UploadState, files: readonly UploadFile[]): UploadView['progress'] {
  if (inFlight(s) === 0) return null;
  const done = files.filter((f) => AT_REST.includes(f.status.s)).length;
  const zip = files.find((f) => f.zip !== undefined && !AT_REST.includes(f.status.s))?.zip;
  const members = zip === undefined ? [] : files.filter((f) => f.zip === zip);
  return {
    done, total: files.length, line: UPLOAD_TEXT.progressFiles(done, files.length),
    zip: zip === undefined ? null : UPLOAD_TEXT.progressZip(zip, members.filter((f) => AT_REST.includes(f.status.s)).length, members.length),
  };
}

/**
 * A read value as the report printed it (the phone's lab review rule, ios/engine/lab-review.ts): the
 * number with its limit sign, its unit, the extractor's question, a note when the read guessed the
 * unit, and the day it saves on: its own, else its report's (`reportDay`). The number shown is the printed
 * one, so the web's "Printed:" line (shown only when the two differ) never applies.
 */
function printedFacts(x: UnifiedExtractionResult | undefined, ref: string, reportDay: string | null, now: string, edit: number | undefined) {
  const i = Number(ref.slice(1));
  const own = ref[0] === 'v' ? x?.values?.[i] : x?.additionalValues?.[i];
  if (!own) return {};
  const coreValue = ref[0] === 'v' ? x!.values![i] : null;
  const number = coreValue ? coreValue.displayValue : x!.additionalValues![i].value;
  const day = own.recordedAt && own.recordedAt !== UNDATED_PREVIOUS ? validDay(own.recordedAt, { now })?.slice(0, 10) ?? null : null;
  // An edited number is what Save writes (`importRow`): a core value in its SI unit, a lab in its own, no limit sign.
  return {
    value: edit !== undefined ? String(edit) : withComparator(String(number), own.comparator),
    unit: edit !== undefined && coreValue ? getDisplayLabel(coreValue.metric as MetricType, 'si') : coreValue ? coreValue.displayUnit : x!.additionalValues![i].unit,
    question: own.question ?? null,
    unitNote: coreValue?.unitGuessed ? REVIEW_CELL_TEXT.checkUnit : null,
    day: day ?? reportDay?.slice(0, 10) ?? null,
  };
}

/** A held row as readers show it: its number with the limit sign this build reads in it (an older build's
 *  copied sign on a correction left out, US-12 AC20) and its unit; never a row no reader can read (US-65 AC3). */
function heldText(row: FileMeasurement | FileLabValue | undefined, record: RoadmapFile): string | null {
  if (!row) return null;
  if (!isReadableRow('metricType' in row ? 'measurements' : 'labValues', row)) return UNREADABLE_VALUE_TEXT;
  const unit = 'metricType' in row ? getDisplayLabel(row.metricType as MetricType, 'si') : row.unit;
  const comparator = 'metricType' in row ? effectiveComparator(record.measurements, row) : effectiveComparator(record.labValues, row);
  return [withComparator(String(row.value), comparator), unit].filter(Boolean).join(' ');
}

const valueRow = (review: UploadReview, reads: Map<string, ReturnType<typeof readFiles>[number]>, rows: Map<string, FileMeasurement | FileLabValue>, record: RoadmapFile, now: string) =>
  (v: ClassifiedValue): ValueRow => {
    const read = reads.get(review.labFiles[v.file].fileId);
    const facts = printedFacts(read?.status.extraction, v.ref, review.labFiles[v.file].day, now, read?.status.choices.edits[v.ref]);
    const heldId = review.held.get(`${v.file}:${v.ref}`);
    const dayLine = facts.day ? longDate(facts.day) ?? facts.day : null;
    return { ...facts, dayLine, ...rowOf(review, v),
      replace: heldId ? REVIEW_CELL_TEXT.replace : null,
      replaceLabel: heldId && dayLine ? REVIEW_CELL_TEXT.replaceLabel(v.label, dayLine) : null,
      held: heldText(heldId ? rows.get(heldId) : undefined, record),
      copy: v.copy ? NOT_SAVED_TEXT.sameDay : null,
    };
  };

const rowOf = (review: UploadReview, v: ClassifiedValue) => ({
  fileId: review.labFiles[v.file].fileId, ref: v.ref, label: v.label,
  reasons: v.group === 'unsure' ? v.reasons : [],
  // A copy of another reading has nothing to resolve: it shows only its own caption (`copy`), never a conflict line.
  conflict: !v.copy && v.group === 'unsure' && v.reasons.includes('conflict')
    ? (replacingOf(review, v) ? UPLOAD_TEXT.replaces : IMPORT_REVIEW_TEXT.conflictKept) : null,
  ticked: review.labFiles[v.file].ticked.includes(v.ref),
  replaces: review.held.get(`${v.file}:${v.ref}`) ?? null,
  replacing: replacingOf(review, v),
  error: blocks(review)(v) && v.refusal && 'measurement' in v.refusal ? v.refusal.measurement.message : null,
});

/** A copy is never written, so its Replace, if one was chosen, does nothing (`copy`). */
const replacingOf = (review: UploadReview, v: ClassifiedValue) => !v.copy && review.labFiles[v.file].replacing.includes(v.ref);

/**
 * A selected core value the write would refuse blocks Save, as the web's review blocks it
 * (ReviewTable `refusedKept` over import-review-view `blocked`, US-13 AC5): sent, not written, and
 * out of its range or otherwise refused (a same-day loser is not an error).
 */
const blocks = (review: UploadReview) => (v: ClassifiedValue) => v.ref[0] === 'v' && v.sent && !v.writes
  && (v.group === 'unsure' ? v.reasons.includes('outOfRange') && (!v.reasons.includes('conflict') || replacingOf(review, v)) : v.group === 'notSaved' && v.reason !== 'sameDay');

/** Each reason once, naming its tests, as "Not saved" names them in the review (NOT_SAVED_TEXT); then each own line once. */
function refusedLines(refused: NonNullable<SaveOutcome['refused']>): string[] {
  const byReason = new Map<NotSavedReason, string[]>();
  const lines = new Set<string>();
  for (const r of refused) {
    if ('line' in r) { lines.add(r.line); continue; }
    const labels = byReason.get(r.reason) ?? [];
    if (!labels.includes(r.label)) byReason.set(r.reason, [...labels, r.label]);
  }
  return [...[...byReason].map(([reason, labels]) => `${labels.join(', ')}: ${NOT_SAVED_TEXT[reason]}`), ...lines];
}

function saveLabel(plan: UploadSavePlan): string {
  const { values, documents, originals } = plan.counts;
  return values || documents || !originals ? UPLOAD_TEXT.saveBoth(values, documents) : UPLOAD_TEXT.saveOriginals(originals);
}

/** A read file with nothing in it, as the web says it (useUploadFlow `finish`): a document alone, or nothing found. */
function emptyRead(f: UploadFile): string | null {
  if (f.status.s !== 'read') return null;
  const x = f.status.extraction;
  const lab = x.classification === 'lab_report';
  if (lab && (x.values?.length ?? 0) + (x.additionalValues?.length ?? 0) + (x.refusedValues?.length ?? 0) > 0) return null;
  if (!lab && x.document) return null;
  return x.document ? FILE_NOTICE_TEXT.documentOnly : FILE_NOTICE_TEXT.noValues;
}

function save(s: UploadState, plan: UploadSavePlan, review: UploadReview): UploadView['save'] {
  const label = saveLabel(plan);
  // After a failed Save, Save tries again, unless the record changed meanwhile so that it would refuse: then it waits, saying why.
  if (s.phase === 'saveFailed') { const why = saveBlocked(review); return { label, enabled: why === null, why, error: s.message }; }
  if (s.phase !== 'open') return { label, enabled: false, why: null, error: null };
  const waiting = inFlight(s);
  const why = waiting ? UPLOAD_TEXT.saveWait(waiting) : saveBlocked(review) ?? (planIsEmpty(plan) ? UPLOAD_TEXT.saveNothing : null);
  return { label, enabled: saveEnabled(s) && why === null, why, error: null };
}

/**
 * Why Save may not write this review, in the view's words, or null: a selected value the write
 * would refuse, or a report still waiting for its day (no report is ever skipped by Save). The
 * save itself refuses on the same rule (upload-save.ts), so nothing is written past it.
 */
export function saveBlocked(review: UploadReview): string | null {
  if (review.classification.values.some(blocks(review))) return FIX_ERRORS_TEXT;
  return review.labFiles.some((f) => f.needsDay) ? UPLOAD_TEXT.chooseDay : null;
}

/**
 * `review`: the caller's `uploadReview`, the same one it hands `uploadSavePlan`, so the screen
 * counts what Save writes. `cloudConnected`: originals are stored, and counted, only with a cloud.
 */
export function uploadView(s: UploadState, record: RoadmapFile, now: string, review: UploadReview, cloudConnected: boolean): UploadView {
  const plan = uploadSavePlan(s, record, now, review, cloudConnected);
  const files = 'files' in s ? s.files : [];
  const values = review.classification.values;
  const readById = new Map(readFiles(s).map((f) => [f.id, f]));
  // Read only for a conflict's held row: no conflict, no index.
  const rowsById = new Map<string, FileMeasurement | FileLabValue>(review.held.size ? [...record.measurements, ...record.labValues].map((r) => [r.id, r]) : []);
  const row = valueRow(review, readById, rowsById, record, now);
  const offered = values.filter((v) => isOfferedRef(v.ref));
  const unsure = offered.filter((v) => v.group === 'unsure');
  const sure = offered.filter((v) => v.group === 'sure');
  const failed = files.filter((f): f is UploadFile & { status: Extract<FileStatus, { s: 'failed' }> } => f.status.s === 'failed');
  const groups = notSavedGroups(values);
  const sections: UploadSection[] = [
    ...review.labFiles.flatMap((f): UploadSection[] => {
      // A report that prints no full day asks for one; once picked, it shows the pick to be changed.
      const read = readById.get(f.fileId);
      const chosen = read && !validDay(read.status.extraction.reportDate ?? undefined, { now }) ? validDay(read.status.choices.testDay ?? undefined, { now })?.slice(0, 10) ?? null : null;
      return f.needsTestDay || chosen ? [{ kind: 'undated', fileId: f.fileId, title: UPLOAD_TEXT.undatedTitle, label: UPLOAD_TEXT.dayOfTest, name: f.name, choose: UPLOAD_TEXT.chooseDay, chosen }] : [];
    }),
    ...review.labFiles.filter((f) => f.needsPreviousDay).map((f): UploadSection => ({ kind: 'undatedPrevious', fileId: f.fileId, name: f.name, month: f.previousMonth, before: f.day?.slice(0, 10) ?? null })),
    ...(unsure.length ? [{ kind: 'unsure' as const, title: IMPORT_REVIEW_TEXT.checkTitle(unsure.length), footer: IMPORT_REVIEW_TEXT.checkFooter, rows: unsure.map(row) }] : []),
    ...(failed.length ? [{
      kind: 'failed' as const, title: UPLOAD_TEXT.failedTitle(failed.length),
      rows: failed.map((f) => ({ fileId: f.id, name: uploadFileName(f), line: failLine(f.status, s.platform) })),
      retry: s.phase === 'open' && failed.some((f) => RETRYABLE[f.status.reason]) ? UPLOAD_TEXT.retryAll : null,
    }] : []),
    ...(groups.total ? [{
      kind: 'notSaved' as const, title: IMPORT_REVIEW_TEXT.notSavedTitle(groups.total),
      lines: [...groups.lines.map((l) => l.text), ...(groups.other ? [groups.other] : [])], footer: IMPORT_REVIEW_TEXT.notSavedFooter,
    }] : []),
  ];
  const waiting = inFlight(s);
  // Held already, equal: one copy of an equal reading of this upload is counted nowhere (one saves), as the web counts.
  const alreadySaved = offered.filter((v) => v.group === 'saved' && !('duplicate' in v && v.duplicate)).length;
  return {
    progress: progress(s, files),
    summary: summary(files, plan, review.labFiles.length),
    sections,
    sure: sure.length ? { line: IMPORT_REVIEW_TEXT.willSave(sure.filter((v) => v.writes).length), showAll: IMPORT_REVIEW_TEXT.showAll(sure.length), rows: sure.map(row), hide: IMPORT_REVIEW_TEXT.hide } : null,
    documents: plan.documents.length ? {
      line: UPLOAD_TEXT.documentsLine(plan.documents.length),
      rows: plan.documents.map(({ fileId, fields }) => {
        const kindKey = documentKind(fields.documentType);
        return {
          fileId, title: fields.title, kind: KIND_WORDS[kindKey][0],
          date: (fields.documentDate && longDate(fields.documentDate.slice(0, 10))) ?? UPLOAD_TEXT.noDate, dateKnown: fields.documentDate !== null,
          kindKey, day: fields.documentDate?.slice(0, 10) ?? null,
        };
      }),
      kinds: DOCUMENT_TYPES.map((key) => ({ key, word: KIND_WORDS[key][0] })),
      setDate: UPLOAD_TEXT.setDate, removeDate: UPLOAD_TEXT.removeDate,
    } : null,
    files: { row: UPLOAD_TEXT.filesRow(files.length), rows: files.map((f) => ({ fileId: f.id, name: uploadFileName(f), status: emptyRead(f) ?? statusWords(f.status, s.platform) })) },
    // Read files with nothing in them, and files read only in part (US-12 AC9), in the web's words.
    notices: files.flatMap((f) => [emptyRead(f), f.pages?.truncated ? FILE_NOTICE_TEXT.truncated : null]
      .flatMap((line) => (line ? [{ fileId: f.id, name: uploadFileName(f), line }] : []))),
    save: save(s, plan, review),
    stop: s.phase === 'open' && waiting ? { label: UPLOAD_TEXT.stop } : null,
    done: s.phase === 'done' ? {
      line: UPLOAD_TEXT.savedLine(s.outcome.values, s.outcome.documents),
      archived: s.outcome.archived ? UPLOAD_TEXT.archivedLine(s.outcome.archived) : null,
      unstored: s.outcome.unstored ? UPLOAD_TEXT.unstoredLine : null,
      skipped: [
        ...(s.outcome.skippedValues ? [UPLOAD_TEXT.skippedLine(s.outcome.skippedValues, false)] : []),
        ...(s.outcome.skippedLabValues ? [UPLOAD_TEXT.skippedLine(s.outcome.skippedLabValues, true)] : []),
      ],
      notSaved: refusedLines(s.outcome.refused ?? []),
    } : null,
    alreadySaved: alreadySaved ? IMPORT_REVIEW_TEXT.alreadySaved(alreadySaved) : null,
    reviewed: reviewedWrites(review),
    phase: s.phase,
    refused: s.phase === 'failed' && s.refused ? REFUSED_TEXT[s.refused] : null,
    closeEnabled: s.phase !== 'saving',
    editable: s.phase === 'open' || s.phase === 'saveFailed',
    doneLabel: UPLOAD_TEXT.done,
  };
}
