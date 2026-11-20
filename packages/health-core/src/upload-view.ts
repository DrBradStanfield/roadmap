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
import { IMPORT_REVIEW_TEXT, isOfferedRef, KIND_WORDS, NOT_SAVED_TEXT, notSavedGroups, type ClassifiedValue, type NotSavedReason, type UnsureReason } from './import-review';
import type { RoadmapFile } from './roadmap-file';
import { inFlight, RETRYABLE, saveEnabled, type FileStatus, type SaveOutcome, type UploadFile, type UploadState } from './upload-flow';
import { planIsEmpty, uploadSavePlan, type UploadSavePlan } from './upload-plan';
import type { UploadReview } from './upload-review';
import { FAIL_TEXT, FILE_NOTICE_TEXT, FIX_ERRORS_TEXT, SCREENING_TEXT, UPLOAD_TEXT, UPLOAD_TEXT_PROPOSED } from './upload-text';

/**
 * `ticked`: the tick shown now, the platform's default resolved. `replaces`: a conflict's held row,
 * for `ChoiceChange` replace; null when there is nothing to replace. `replacing`: the Replace
 * control is on and still aimed at that row; `conflict` then says what Save will do. `error`: a
 * selected core value Save would refuse, in the write's words; it blocks Save (US-13 AC5).
 */
export interface ValueRow {
  fileId: string; ref: string; label: string; reasons: UnsureReason[]; conflict: string | null;
  ticked: boolean; replaces: string | null; replacing: boolean; error: string | null;
}
export type UploadSection =
  | { kind: 'undated'; fileId: string; title: string; label: string; name: string }
  /** An undated previous column's day (US-12 AC14; web only): a day in `month` (YYYY-MM) before
   *  `before`, when known. Its words stay in the web's ReviewTable until they move (no string yet). */
  | { kind: 'undatedPrevious'; fileId: string; name: string; month: string | null; before: string | null }
  | { kind: 'unsure'; title: string; footer: string; rows: ValueRow[] }
  /** `retry`: Try again for this file alone, when its failure is one a retry can mend; the section's `retry` is every such file. */
  | { kind: 'failed'; title: string; rows: Array<{ fileId: string; name: string; line: string; retry: string | null }>; retry: string | null }
  | { kind: 'notSaved'; title: string; lines: string[]; footer: string };

export interface UploadView {
  /** Null once nothing is in flight. `zip`: the ZIP being opened, while one is. */
  progress: { done: number; total: number; line: string; zip: string | null } | null;
  summary: string;
  sections: UploadSection[];
  /** Hidden behind Show all. */
  sure: { line: string; showAll: string; rows: ValueRow[] } | null;
  /** `screening`: a letter's screening update the person can tick (web), null when none is offered. */
  documents: { line: string; rows: Array<{ fileId: string; title: string; kind: string; date: string; dateKnown: boolean; screening: ScreeningRow | null }> } | null;
  /** The collapsed "Files" list. */
  files: { row: string; rows: Array<{ fileId: string; name: string; status: string }> };
  /** Read files with nothing in them, and files read only in part, in the web's notice words (US-12 AC9). */
  notices: Array<{ fileId: string; name: string; line: string }>;
  /** `error`: a failed save's message; Save then retries. */
  save: { label: string; enabled: boolean; why: string | null; error: string | null };
  stop: { label: string } | null;
  /** The done screen's lines. */
  /** `notSaved`: values the final commit refused, one line per reason in the review's words. */
  done: { line: string; archived: string | null; unstored: string | null; skipped: string[]; notSaved: string[] } | null;
}

/** A screening update's tick: `checked` only with a date; `words` around the screening's name, which is drawn bold. */
export interface ScreeningRow { checked: boolean; enabled: boolean; words: readonly [string, string, string] }

const READING: readonly FileStatus['s'][] = ['converting', 'sending'];
const AT_REST: readonly FileStatus['s'][] = ['known', 'refused', 'read', 'failed', 'stopped'];

function statusWords(status: FileStatus): string {
  switch (status.s) {
    case 'known': return UPLOAD_TEXT.statusKnown;
    case 'refused': return UPLOAD_TEXT.statusRefused(status.verdict);
    case 'read': return UPLOAD_TEXT.statusRead;
    case 'failed': return FAIL_TEXT[status.reason];
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
    const kind = (DOCUMENT_TYPES as readonly string[]).includes(fields.documentType) ? fields.documentType as DocumentType : 'other';
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

const valueRow = (review: UploadReview) => (v: ClassifiedValue): ValueRow => ({
  fileId: review.labFiles[v.file].fileId, ref: v.ref, label: v.label,
  reasons: v.group === 'unsure' ? v.reasons : [],
  conflict: v.group === 'unsure' && v.reasons.includes('conflict')
    ? (replacingOf(review, v) ? UPLOAD_TEXT_PROPOSED.replaces : IMPORT_REVIEW_TEXT.conflictKept) : null,
  ticked: review.labFiles[v.file].ticked.includes(v.ref),
  replaces: review.held.get(`${v.file}:${v.ref}`) ?? null,
  replacing: replacingOf(review, v),
  error: blocks(v) && v.refusal && 'measurement' in v.refusal ? v.refusal.measurement.message : null,
});

const replacingOf = (review: UploadReview, v: ClassifiedValue) => review.labFiles[v.file].replacing.includes(v.ref);

/**
 * A selected core value the write would refuse blocks Save, as the web's review blocks it
 * (ReviewTable `refusedKept` over import-review-view `blocked`, US-13 AC5): sent, not written, and
 * out of its range or otherwise refused (a same-day loser is not an error).
 */
const blocks = (v: ClassifiedValue) => v.ref[0] === 'v' && v.sent && !v.writes
  && (v.group === 'unsure' ? v.reasons.includes('outOfRange') : v.group === 'notSaved' && v.reason !== 'sameDay');

/** Each reason once, naming its tests, as "Not saved" names them in the review (NOT_SAVED_TEXT). */
function refusedLines(refused: NonNullable<SaveOutcome['refused']>): string[] {
  const byReason = new Map<NotSavedReason, string[]>();
  for (const { label, reason } of refused) {
    const labels = byReason.get(reason) ?? [];
    if (!labels.includes(label)) byReason.set(reason, [...labels, label]);
  }
  return [...byReason].map(([reason, labels]) => `${labels.join(', ')}: ${NOT_SAVED_TEXT[reason]}`);
}

function screeningRow(plan: UploadSavePlan, fileId: string): ScreeningRow | null {
  const update = plan.screenings.find((x) => x.fileId === fileId);
  if (!update?.shown) return null;
  return { checked: update.date !== null && update.ticked, enabled: update.date !== null, words: SCREENING_TEXT.update(update.type, update.date) };
}

function saveLabel(plan: UploadSavePlan): string {
  const { values, documents, originals } = plan.counts;
  return values || documents || !originals ? UPLOAD_TEXT.saveBoth(values, documents) : UPLOAD_TEXT_PROPOSED.saveOriginals(originals);
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
  if (s.phase === 'saveFailed') return { label, enabled: true, why: null, error: s.message };
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
  if (review.classification.values.some(blocks)) return FIX_ERRORS_TEXT;
  return review.labFiles.some((f) => f.needsDay) ? UPLOAD_TEXT_PROPOSED.chooseDay : null;
}

/**
 * `review`: the caller's `uploadReview`, the same one it hands `uploadSavePlan`, so the screen
 * counts what Save writes. `cloudConnected`: originals are stored, and counted, only with a cloud.
 */
export function uploadView(s: UploadState, record: RoadmapFile, now: string, review: UploadReview, cloudConnected: boolean): UploadView {
  const plan = uploadSavePlan(s, record, now, review, cloudConnected);
  const files = 'files' in s ? s.files : [];
  const values = review.classification.values;
  const row = valueRow(review);
  const offered = values.filter((v) => isOfferedRef(v.ref));
  const unsure = offered.filter((v) => v.group === 'unsure');
  const sure = offered.filter((v) => v.group === 'sure');
  const failed = files.filter((f): f is UploadFile & { status: Extract<FileStatus, { s: 'failed' }> } => f.status.s === 'failed');
  const groups = notSavedGroups(values);
  const sections: UploadSection[] = [
    ...review.labFiles.filter((f) => f.needsTestDay).map((f): UploadSection => ({ kind: 'undated', fileId: f.fileId, title: UPLOAD_TEXT.undatedTitle, label: UPLOAD_TEXT.dayOfTest, name: f.name })),
    ...review.labFiles.filter((f) => f.needsPreviousDay).map((f): UploadSection => ({ kind: 'undatedPrevious', fileId: f.fileId, name: f.name, month: f.previousMonth, before: f.day?.slice(0, 10) ?? null })),
    ...(unsure.length ? [{ kind: 'unsure' as const, title: IMPORT_REVIEW_TEXT.checkTitle(unsure.length), footer: IMPORT_REVIEW_TEXT.checkFooter, rows: unsure.map(row) }] : []),
    ...(failed.length ? [{
      kind: 'failed' as const, title: UPLOAD_TEXT.failedTitle(failed.length),
      rows: failed.map((f) => ({ fileId: f.id, name: f.name, line: FAIL_TEXT[f.status.reason], retry: s.phase === 'open' && RETRYABLE[f.status.reason] ? UPLOAD_TEXT.retryAll : null })),
      retry: s.phase === 'open' && failed.some((f) => RETRYABLE[f.status.reason]) ? UPLOAD_TEXT.retryAll : null,
    }] : []),
    ...(groups.total ? [{
      kind: 'notSaved' as const, title: IMPORT_REVIEW_TEXT.notSavedTitle(groups.total),
      lines: [...groups.lines.map((l) => l.text), ...(groups.other ? [groups.other] : [])], footer: IMPORT_REVIEW_TEXT.notSavedFooter,
    }] : []),
  ];
  const waiting = inFlight(s);
  return {
    progress: progress(s, files),
    summary: summary(files, plan, review.labFiles.length),
    sections,
    sure: sure.length ? { line: IMPORT_REVIEW_TEXT.willSave(sure.filter((v) => v.writes).length), showAll: IMPORT_REVIEW_TEXT.showAll(sure.length), rows: sure.map(row) } : null,
    documents: plan.documents.length ? {
      line: UPLOAD_TEXT.documentsLine(plan.documents.length),
      rows: plan.documents.map(({ fileId, fields }) => ({
        fileId, title: fields.title,
        kind: KIND_WORDS[(DOCUMENT_TYPES as readonly string[]).includes(fields.documentType) ? fields.documentType as DocumentType : 'other'][0],
        date: fields.documentDate ?? UPLOAD_TEXT.noDate, dateKnown: fields.documentDate !== null,
        screening: screeningRow(plan, fileId),
      })),
    } : null,
    files: { row: UPLOAD_TEXT.filesRow(files.length), rows: files.map((f) => ({ fileId: f.id, name: f.name, status: emptyRead(f) ?? statusWords(f.status) })) },
    // Read files with nothing in them, and files read only in part (US-12 AC9), in the web's words.
    notices: files.flatMap((f) => [emptyRead(f), f.pages?.truncated ? FILE_NOTICE_TEXT.truncated : null]
      .flatMap((line) => (line ? [{ fileId: f.id, name: f.name, line }] : []))),
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
  };
}
