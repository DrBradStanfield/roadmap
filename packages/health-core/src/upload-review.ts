/**
 * The upload's one classification (US-13 AC13): every read lab report's values, classified
 * across ALL read files at once by `classifyImportValues`. The view (upload-view.ts), the
 * write (upload-plan.ts) and the receipt read this same object, so what the screen counts is
 * what Save writes. Compute it once per state and hand it to both.
 */
import { classifyImportValues, importRow, valueDays, type ImportClassification, type ImportFile } from './import-review';
import { validDay, type BulkRow } from './record-edits';
import type { RoadmapFile } from './roadmap-file';
import type { UploadFile, UploadState } from './upload-flow';

type ReadFile = UploadFile & { status: Extract<UploadFile['status'], { s: 'read' }> };

export interface UploadReview {
  /** The read lab reports, in picked order; `classification.values[i].file` indexes this list. */
  labFiles: Array<{ fileId: string; name: string; day: string | null; needsDay: boolean; hasValues: boolean }>;
  classification: ImportClassification;
  /** The rows Save writes, by file, in Save's order (`classification.rows` split by file). */
  rowsByFile: Map<string, BulkRow[]>;
}

export const readFiles = (s: UploadState): ReadFile[] =>
  ('files' in s ? s.files : []).filter((f): f is ReadFile => f.status.s === 'read');
export const isLabReport = (f: ReadFile) => f.status.extraction.classification === 'lab_report';

/**
 * One report as `classifyImportValues` takes it: today's iPhone rule (ios/engine
 * lab-review-groups.ts `classifyReport`). A value the extractor asked about starts unticked
 * (LabChoices); the person's ticks win. Each ticked value is on its own day or the test's: the
 * person's pick, else the report's own full day.
 */
function importFile(f: ReadFile, now: string): { file: ImportFile; day: string | null; needsDay: boolean } {
  const { extraction, choices } = f.status;
  const result = extraction as ImportFile['result'];
  const day = validDay(choices.testDay ?? extraction.reportDate ?? undefined, { now });
  const days = valueDays(result, day);
  const offered = [
    ...(extraction.values ?? []).map((v, i) => ({ ref: `v${i}`, question: !!v.question, own: v.recordedAt })),
    ...(extraction.additionalValues ?? []).map((v, i) => ({ ref: `a${i}`, question: !!v.question, own: v.recordedAt })),
  ];
  const ticked = offered.filter(({ ref, question }) => choices.ticks[ref] ?? !question);
  // A ticked value with no day of its own waits for the test's day, and so does the whole report:
  // neither client saves part of a report before its day is set (iPhone `valuesWait`, web `allDatesSet`).
  const needsDay = day === null && ticked.some((v) => v.own === undefined);
  const rows: Record<string, BulkRow> = {};
  for (const { ref } of needsDay ? [] : ticked) {
    const on = days[ref] ? validDay(days[ref]!, { now }) : null;
    const row = on ? importRow(result, ref, on) : null;
    if (row) rows[ref] = row;
  }
  return { file: { result, rows, days }, day, needsDay };
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
      fileId: f.id, name: f.name, day: built[i].day, needsDay: built[i].needsDay,
      hasValues: (f.status.extraction.values?.length ?? 0) + (f.status.extraction.additionalValues?.length ?? 0) > 0,
    })),
    classification,
    rowsByFile,
  };
}
