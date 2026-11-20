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
import type { UploadFile, UploadState } from './upload-flow';
import { letterValuesOffered } from './upload-rules';

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
  /** Whom a letter's screening update is judged for (the web's plan, US-06 AC5); null: none is offered (the iPhone, until its words are approved). */
  screening: ScreeningProfile | null;
}

/** A value the reviewed page would write: its file, its ref, and whether it is another lab (not a core value). */
export interface ReviewedValue { file: string; ref: string; lab: boolean }

/**
 * What the page the person reviewed would write, for `saveStarted` to carry (owner ruling 2026-11-20,
 * US-12 AC6a): Save runs on the record as it is then, and names each of these it did not write.
 */
export function reviewedWrites(review: UploadReview): ReviewedValue[] {
  // The written values come first in `values`, in the order of `rows` (import-review.ts).
  return review.classification.values.filter((v) => v.sent && v.writes)
    .map((v, k) => ({ file: review.labFiles[v.file].fileId, ref: v.ref, lab: review.classification.rows[k].kind === 'lab' }));
}

/**
 * The Replace choices whose target no longer holds the value's slot on the record the review was judged
 * on (another writer moved or corrected it), for `replacesLost` (owner ruling 2026-11-20, US-13 AC7).
 */
export function lostReplaces(review: UploadReview, s: UploadState): Array<{ id: string; ref: string }> {
  return readFiles(s).flatMap((f) => {
    const lab = review.labFiles.find((l) => l.fileId === f.id);
    return lab ? Object.keys(f.status.choices.replace).filter((ref) => !lab.replacing.includes(ref)).map((ref) => ({ id: f.id, ref })) : [];
  });
}

/** The plan's age and sex, as the web's review took them for `isScreeningEligible`; either may be unknown. */
export interface ScreeningProfile { age?: number; sex?: 'male' | 'female' }

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
 * on the row, as the web's review sends them through `chose`.
 */
function importFile(f: ReadFile, now: string, holderOf: (row: BulkRow) => string | undefined) {
  const { choices } = f.status;
  // A dated previous column's pick as a real past day, or null while it is not one yet (PR 1906 item 10).
  const columnDays = Object.entries(choices.columnDays ?? {}).map(([printed, day]) => [printed, validDay(day, { now })] as const);
  const extraction = withColumnDays(f.status.extraction, Object.fromEntries(columnDays.filter(([, day]) => day !== null)) as Record<string, string>);
  // A letter whose values the platform offers (D3) is classified as the report its values are.
  const result = { ...extraction, classification: 'lab_report' } as ImportFile['result'];
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
  // A dated previous column whose pick is no real past day yet: its ticked values wait for one (PR 1906 item 10).
  const waiting = columnDays.filter(([, day]) => day === null).map(([printed]) => printed);
  // And a ticked value printed on a day that is no real past day (a date still to come): it waits for its
  // column's day too, never dropped at Save (PR 1906 Codex pass).
  const needsColumnDay = ticked.some((v) => v.own !== undefined && v.own !== UNDATED_PREVIOUS && (waiting.includes(v.own) || validDay(v.own, { now }) === null));
  // A Replace counts only while its target is still the held row on the value's day (US-13 AC7).
  const days = valueDays(result, day, undatedDay);
  const replaces = (ref: string) => {
    const target = choices.replace[ref];
    const row = target && days[ref] ? importRow(result, ref, validDay(days[ref]!, { now }) ?? days[ref]!) : null;
    return row && holderOf(row) === target ? target : undefined;
  };
  // The chosen target goes on the row even when it no longer holds the slot: the write then refuses
  // the stale target and the value is not written, never turned into a new row (US-35 AC8; PR 1906 item 1).
  const options = Object.fromEntries(offered.map(({ ref }) => {
    const correctsId = choices.replace[ref];
    return [ref, { ...(correctsId ? { correctsId } : {}), ...(choices.edits[ref] !== undefined ? { edited: { value: choices.edits[ref] } } : {}) }];
  }));
  const file = reportImportFile(result, needsTestDay || needsPreviousDay || needsColumnDay ? [] : ticked.map((v) => v.ref), day, now, undatedDay, options);
  return { file, day, ticked: ticked.map((v) => v.ref), needsTestDay, needsPreviousDay, needsColumnDay, replacing: offered.map(({ ref }) => ref).filter((ref) => replaces(ref)) };
}

/** A dated previous column's values on the day the person picked for it (US-12 AC12); the extraction itself when none. */
function withColumnDays(x: ReadFile['status']['extraction'], days: Readonly<Record<string, string>>): ReadFile['status']['extraction'] {
  if (!Object.keys(days).length) return x;
  // Only a real past day moves its values (`days` holds no other); a pick still waiting leaves them printed, and the report waits (`needsColumnDay`).
  const moved = <V extends { recordedAt?: string }>(v: V): V => (v.recordedAt && days[v.recordedAt] ? { ...v, recordedAt: days[v.recordedAt] } : v);
  return { ...x, values: x.values?.map(moved), additionalValues: x.additionalValues?.map(moved) };
}

/**
 * Recompute after `answered`, `chose` or a record change; the same result feeds the view and the plan.
 * `screening`: the web's plan age and sex, so a letter's screening update is offered; absent, none is.
 */
export function uploadReview(s: UploadState, record: RoadmapFile, now: string, screening?: ScreeningProfile): UploadReview {
  const platform = 'platform' in s ? s.platform : 'web';
  // The read lab reports, and on a platform that offers them, a letter's values (D3, upload-rules.ts).
  const printsValues = (f: ReadFile) => (f.status.extraction.values?.length ?? 0) + (f.status.extraction.additionalValues?.length ?? 0) > 0;
  const labs = readFiles(s).filter((f) => isLabReport(f) || (letterValuesOffered(platform) && printsValues(f)));
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
      fileId: f.id, name: f.name, day: built[i].day, ticked: built[i].ticked, replacing: built[i].replacing,
      needsDay: built[i].needsTestDay || built[i].needsPreviousDay || built[i].needsColumnDay, needsTestDay: built[i].needsTestDay, needsPreviousDay: built[i].needsPreviousDay,
      previousMonth: [...(f.status.extraction.values ?? []), ...(f.status.extraction.additionalValues ?? [])].find((v) => v.printedMonth)?.printedMonth ?? null,
    })),
    classification,
    rowsByFile,
    held,
    screening: screening ?? null,
  };
}
