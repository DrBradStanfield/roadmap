/**
 * The upload's one classification (US-13 AC13): every read lab report's values, classified
 * across ALL read files at once by `classifyImportValues`. The view (upload-view.ts), the
 * write (upload-plan.ts) and the receipt read this same object, so what the screen counts is
 * what Save writes. The caller owns it: recompute it after `answered`, `chose` or a record
 * change, and pass the same one to `uploadView` and `uploadSavePlan`.
 */
import { UNDATED_PREVIOUS } from './lab-extraction';
import { classifyImportValues, reportImportFile, type ImportClassification, type ImportFile } from './import-review';
import { validDay, type BulkRow } from './record-edits';
import type { RoadmapFile } from './roadmap-file';
import type { UploadFile, UploadState } from './upload-flow';

type ReadFile = UploadFile & { status: Extract<UploadFile['status'], { s: 'read' }> };

export interface UploadReview {
  /** The read lab reports, in picked order; `classification.values[i].file` indexes this list. */
  labFiles: Array<{
    fileId: string; name: string; day: string | null; hasValues: boolean;
    /** The report waits for the test's day, or for its undated previous column's: none of it saves until then. */
    needsDay: boolean; needsTestDay: boolean; needsPreviousDay: boolean;
    /** The month an undated previous column printed (YYYY-MM), if any. */
    previousMonth: string | null;
  }>;
  classification: ImportClassification;
  /** The rows Save writes, by file, in Save's order (`classification.rows` split by file). */
  rowsByFile: Map<string, BulkRow[]>;
}

export const readFiles = (s: UploadState): ReadFile[] =>
  ('files' in s ? s.files : []).filter((f): f is ReadFile => f.status.s === 'read');
export const isLabReport = (f: ReadFile) => f.status.extraction.classification === 'lab_report';

/**
 * An undated previous column's day as the web takes it (ReviewTable.tsx `datedColumns`,
 * `handleColumnDateChange`, US-12 AC14): a real past day, and before the report's own day when
 * that is known; any other pick is refused, so the column still has none.
 */
export function previousDay(pick: string | null, reportDay: string | null, now: string): string | null {
  const day = validDay(pick ?? undefined, { now });
  return day && (!reportDay || day.slice(0, 10) < reportDay.slice(0, 10)) ? day : null;
}

/**
 * One report as `classifyImportValues` takes it: today's iPhone rule (ios/engine
 * lab-review-groups.ts `classifyReport`). A value the extractor asked about starts unticked
 * (LabChoices); the person's ticks win. Each ticked value is on its own day or the test's: the
 * person's pick, else the report's own full day; an undated previous column's on its own day.
 */
function importFile(f: ReadFile, now: string): { file: ImportFile; day: string | null; needsTestDay: boolean; needsPreviousDay: boolean } {
  const { extraction, choices } = f.status;
  const result = extraction as ImportFile['result'];
  const day = validDay(choices.testDay ?? extraction.reportDate ?? undefined, { now });
  const undatedDay = previousDay(choices.previousDay, day, now);
  const offered = [
    ...(extraction.values ?? []).map((v, i) => ({ ref: `v${i}`, question: !!v.question, own: v.recordedAt })),
    ...(extraction.additionalValues ?? []).map((v, i) => ({ ref: `a${i}`, question: !!v.question, own: v.recordedAt })),
  ];
  const ticked = offered.filter(({ ref, question }) => choices.ticks[ref] ?? !question);
  // A ticked value with no day of its own waits for the test's day, one in an undated previous
  // column for that column's, and so does the whole report: neither client saves part of a report
  // before its days are set (iPhone `valuesWait`, web `allDatesSet`).
  const needsTestDay = day === null && ticked.some((v) => v.own === undefined);
  const needsPreviousDay = undatedDay === null && ticked.some((v) => v.own === UNDATED_PREVIOUS);
  const file = reportImportFile(result, needsTestDay || needsPreviousDay ? [] : ticked.map((v) => v.ref), day, now, undatedDay);
  return { file, day, needsTestDay, needsPreviousDay };
}

export function uploadReview(s: UploadState, record: RoadmapFile, now: string): UploadReview {
  const labs = readFiles(s).filter(isLabReport);
  const built = labs.map((f) => importFile(f, now));
  const classification = classifyImportValues(built.map((b) => b.file), record, now);
  // The written values come first in `values`, in the order of `rows` (import-review.ts).
  const written = classification.values.filter((v) => v.sent && v.writes);
  const rowsByFile = new Map<string, BulkRow[]>();
  classification.rows.forEach((row, k) => {
    const id = labs[written[k].file].id;
    const rows = rowsByFile.get(id);
    if (rows) rows.push(row);
    else rowsByFile.set(id, [row]);
  });
  return {
    labFiles: labs.map((f, i) => ({
      fileId: f.id, name: f.name, day: built[i].day,
      needsDay: built[i].needsTestDay || built[i].needsPreviousDay, needsTestDay: built[i].needsTestDay, needsPreviousDay: built[i].needsPreviousDay,
      previousMonth: [...(f.status.extraction.values ?? []), ...(f.status.extraction.additionalValues ?? [])].find((v) => v.printedMonth)?.printedMonth ?? null,
      hasValues: (f.status.extraction.values?.length ?? 0) + (f.status.extraction.additionalValues?.length ?? 0) > 0,
    })),
    classification,
    rowsByFile,
  };
}
