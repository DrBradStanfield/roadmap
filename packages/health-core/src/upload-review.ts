/**
 * The upload's one classification (US-13 AC13): every read lab report's values, classified
 * across ALL read files at once by `classifyImportValues`. The view (upload-view.ts), the
 * write (upload-plan.ts) and the receipt read this same object, so what the screen counts is
 * what Save writes. The caller owns it: recompute it after `answered`, `chose` or a record
 * change, and pass the same one to `uploadView` and `uploadSavePlan`.
 */
import { UNDATED_PREVIOUS } from './lab-extraction';
import { classifyImportValues, importRow, reportImportFile, valueDays, type ImportClassification, type ImportFile } from './import-review';
import { bulkRowTarget } from './bulk-row-target';
import { slotIndex, slotKey, validDay, type BulkRow } from './record-edits';
import type { RoadmapFile } from './roadmap-file';
import { uploadFileName, type UploadFile, type UploadState } from './upload-flow';

type ReadFile = UploadFile & { status: Extract<UploadFile['status'], { s: 'read' }> };

export interface UploadReview {
  /** The read lab reports, in picked order; `classification.values[i].file` indexes this list. */
  labFiles: Array<{
    fileId: string; name: string; day: string | null;
    /** The refs ticked now: every value the person has not cleared. */
    ticked: string[];
    /** The refs whose Replace stands: still aimed at the held row on the value's day. */
    replacing: string[];
    /** The report waits for the test's day, or for its undated previous column's: none of it saves, and Save waits. */
    needsDay: boolean; needsTestDay: boolean; needsPreviousDay: boolean;
    /** The month an undated previous column printed (YYYY-MM), if any. */
    previousMonth: string | null;
  }>;
  classification: ImportClassification;
  /** The rows Save writes, by file, in Save's order (`classification.rows` split by file). */
  rowsByFile: Map<string, BulkRow[]>;
  /** A conflict's held row, by `<file index>:<ref>`: what Replace corrects (`ChoiceChange` replace). */
  held: Map<string, string>;
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
 * One report as `classifyImportValues` takes it (`reportImportFile`, the row rule the iPhone's
 * `classifyReport` shares). Each value starts ticked, one the extractor asked about included, on
 * both clients: saved unless cleared (Brad 2026-11-20: "we need to back ourselves that we are
 * going to get this right"); the person's ticks win. Each ticked value is on its own day or the test's (the person's pick, else the report's
 * own full day); an undated previous column's on its own day. Replace and an edited number go
 * on the row as the web's review puts them (import-review-view.ts `classifyReview`).
 */
function importFile(f: ReadFile, now: string, holderOf: (row: BulkRow) => string | undefined) {
  const { extraction, choices } = f.status;
  const result = extraction as ImportFile['result'];
  const day = validDay(choices.testDay ?? extraction.reportDate ?? undefined, { now });
  const undatedDay = previousDay(choices.previousDay, day, now);
  const offered = [
    ...(extraction.values ?? []).map((v, i) => ({ ref: `v${i}`, value: v, own: v.recordedAt })),
    ...(extraction.additionalValues ?? []).map((v, i) => ({ ref: `a${i}`, value: v, own: v.recordedAt })),
  ];
  const ticked = offered.filter(({ ref }) => choices.ticks[ref] ?? true);
  // A ticked value with no day of its own waits for the test's day, one in an undated previous
  // column for that column's, and so does the whole report (iPhone `valuesWait`, web `allDatesSet`).
  const needsTestDay = day === null && ticked.some((v) => v.own === undefined);
  const needsPreviousDay = undatedDay === null && ticked.some((v) => v.own === UNDATED_PREVIOUS);
  // A Replace counts only while its target is still the held row on the value's day (US-13 AC7).
  const days = valueDays(result, day, undatedDay);
  const replaces = (ref: string) => {
    const target = choices.replace[ref];
    const row = target && days[ref] ? importRow(result, ref, validDay(days[ref]!, { now }) ?? days[ref]!) : null;
    return row && holderOf(row) === target ? target : undefined;
  };
  const options = Object.fromEntries(offered.map(({ ref }) => {
    const correctsId = replaces(ref);
    return [ref, { ...(correctsId ? { correctsId } : {}), ...(choices.edits[ref] !== undefined ? { edited: { value: choices.edits[ref] } } : {}) }];
  }));
  const file = reportImportFile(result, needsTestDay || needsPreviousDay ? [] : ticked.map((v) => v.ref), day, now, undatedDay, options);
  return { file, day, ticked: ticked.map((v) => v.ref), needsTestDay, needsPreviousDay, replacing: Object.keys(options).filter((ref) => options[ref].correctsId) };
}

/** Recompute after `answered`, `chose` or a record change; the same result feeds the view and the plan. */
export function uploadReview(s: UploadState, record: RoadmapFile, now: string): UploadReview {
  const labs = readFiles(s).filter(isLabReport);
  // The record's slots, indexed once: each conflict's held row, and each Replace's check.
  const slots = slotIndex(record);
  const holderOf = (row: BulkRow) => {
    const target = bulkRowTarget(row);
    return slots.get(slotKey(target.slot, target.metric, row.recordedAt))?.id;
  };
  const built = labs.map((f) => importFile(f, now, holderOf));
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
  const held = new Map<string, string>();
  for (const v of classification.values) {
    if (v.group !== 'unsure' || !v.reasons.includes('conflict')) continue;
    const { file } = built[v.file];
    const day = file.days[v.ref];
    const row = day ? importRow(file.result, v.ref, day) : null;
    const holder = row && holderOf(row);
    if (holder) held.set(`${v.file}:${v.ref}`, holder);
  }
  return {
    labFiles: labs.map((f, i) => ({
      fileId: f.id, name: uploadFileName(f), day: built[i].day, ticked: built[i].ticked, replacing: built[i].replacing,
      needsDay: built[i].needsTestDay || built[i].needsPreviousDay, needsTestDay: built[i].needsTestDay, needsPreviousDay: built[i].needsPreviousDay,
      previousMonth: [...(f.status.extraction.values ?? []), ...(f.status.extraction.additionalValues ?? [])].find((v) => v.printedMonth)?.printedMonth ?? null,
    })),
    classification,
    rowsByFile,
    held,
  };
}
