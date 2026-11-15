/**
 * The website review's groups over its matrix (US-13 AC13). Every group (sure, saved, unsure,
 * waiting, not saved) comes from the upload's one classification (health-core `uploadReview`, the
 * same the view counts and Save writes); this file lays the groups over the matrix and counts them.
 * Design: docs/drafts/import-review-redesign.md, docs/drafts/upload-shared-engine.md PR 10.
 */
import { importRow, notSavedGroups, refusedAlone, type ClassifiedValue, type ImportFile } from '@roadmap/health-core/import-review';
import type { UploadReview } from '@roadmap/health-core/upload-review';
import { UPLOAD_OUTCOME_MAX, type UploadReviewKey } from '@roadmap/health-core/product-events';
import type { MeasurementRefusal } from '@roadmap/health-core/record-edits';
import { columnDay, parseReportDate } from './review-dates';
import type { FileResult } from './upload-pipeline';
import { editId, matrixCellKey, matrixRowKey, type CoreCellView, type DateKey, type buildMatrixModel } from './review-matrix';

type Matrix = ReturnType<typeof buildMatrixModel>;
type Group = ClassifiedValue['group'];

/** The extraction as health-core reads it: a file with only a document is not a lab report. */
const extraction = (r: FileResult): ImportFile['result'] => ({
  classification: r.document && r.values.length + r.additionalValues.length === 0 ? r.document.classification : 'lab_report',
  values: r.values as NonNullable<ImportFile['result']['values']>,
  additionalValues: r.additionalValues as NonNullable<ImportFile['result']['additionalValues']>,
  refusedValues: r.refusedValues,
  unreadValues: r.unreadValues,
  droppedValueCount: r.droppedValueCount,
  document: r.document as ImportFile['result']['document'],
});

/** `editId` → its file and its ref in the extraction. */
export const refAt = (id: string) => ({ fi: Number(id.slice(0, id.indexOf(':'))), ref: id.slice(id.indexOf(':') + 1) });

/** The values the write refuses on their own (`refusedAlone`), by `editId`,
 *  at their current number: the matrix gives them no slot, as the review's
 *  groups do. A cleared value is never one. */
export function slotlessIds(results: FileResult[], edits: ReadonlyMap<string, number | null>): Set<string> {
  const now = new Date().toISOString();
  const ids = new Set<string>();
  results.forEach((r, fi) => {
    const result = extraction(r);
    for (const ref of [...r.values.map((_, i) => `v${i}`), ...r.additionalValues.map((_, i) => `a${i}`)]) {
      const edit = edits.get(`${fi}:${ref}`);
      if (edit === null) continue;
      // Any real day: a refusal on its own never depends on the day.
      const row = importRow(result, ref, '2000-01-01', edit === undefined ? {} : { edited: { value: edit } });
      if (row && refusedAlone(row, now)) ids.add(`${fi}:${ref}`);
    }
  });
  return ids;
}

/**
 * The review's groups, by `editId` (`<lab file index>:<ref>`, the matrix's), from the upload's one
 * classification: what the matrix shows and hides, what "Not saved" lists, and the write's own
 * refusal of a selected core value for its cell's line (US-13 AC5).
 */
export function reviewGroups(review: UploadReview) {
  const classified = review.classification.values;
  const id = (v: ClassifiedValue) => `${v.file}:${v.ref}`;
  /** A selected value the write would refuse: the view blocks Save until it is corrected or cleared (US-13 AC5). */
  const refused = classified.filter(v => v.sent && !v.writes && (v.group === 'unsure' ? v.reasons.includes('outOfRange') : v.group === 'notSaved' && v.reason !== 'sameDay'));
  return {
    groupOf: new Map<string, Group>(classified.map(v => [id(v), v.group])),
    /** The values Save writes, by `editId`. */
    writes: new Set(classified.filter(v => v.writes).map(id)),
    count: (group: Group) => classified.filter(v => v.group === group).length,
    /** Values the record already holds; an equal reading of this upload is counted nowhere (one copy saves). */
    held: classified.filter(v => v.group === 'saved' && !v.duplicate).length,
    notSaved: notSavedGroups(classified),
    /** The write's own refusal of a kept core value (`ImportRefusal`), for its cell's line. */
    refusals: new Map(refused.flatMap(v => (v.refusal && 'measurement' in v.refusal ? [[id(v), v.refusal.measurement] as [string, MeasurementRefusal]] : []))),
  };
}
export type ReviewGroups = ReturnType<typeof reviewGroups>;

/**
 * The rows the review shows by default: each row holding a value to look at.
 * The core's group decides (anything not sure); guards keep a value that
 * would otherwise block or change Save in sight whatever the group says: a
 * conflict with a saved value (US-13 AC3), an error in the cell (US-13 AC5),
 * a column that needs or needed a day the report did not print, so a pick
 * never hides what it dated (US-13 AC8, US-12 AC14), and a value the person
 * edited, so an edit never hides its own row. Every value in a shown row is
 * shown; `hidden` are the rest, which save on Save as before.
 */
export function reviewRows(matrix: Matrix, results: FileResult[], groupOf: ReadonlyMap<string, Group>, views: ReadonlyMap<string, CoreCellView>, needsDay: ReadonlySet<DateKey>, edited: ReadonlySet<string>) {
  // A primary column's source is its file's index; a printed previous day's is `fi@day` (`dateSource`).
  const askedDay = (col: Matrix['columns'][number]) => !!col.undated || needsDay.has(col.dateKey)
    || col.sources.some(src => !src.includes('@') && !columnDay(parseReportDate(results[Number(src)]?.reportDate ?? null)));
  const shownRows = new Set<string>();
  const ids = new Map<string, string[]>();
  for (const row of [...matrix.coreRows, ...matrix.additionalRows]) {
    const rowKey = matrixRowKey(row);
    const rowIds: string[] = [];
    for (const col of matrix.columns) {
      const cell = matrix.cells.get(matrixCellKey(rowKey, col.dateKey));
      if (cell?.state !== 'editable') continue;
      const id = editId(cell);
      rowIds.push(id);
      if (groupOf.get(id) !== 'sure' || cell.existing || views.get(id)?.error || askedDay(col) || edited.has(id)) shownRows.add(rowKey);
    }
    ids.set(rowKey, rowIds);
  }
  const shown = new Set<string>();
  const hidden = new Set<string>();
  for (const [rowKey, rowIds] of ids) for (const id of rowIds) (shownRows.has(rowKey) ? shown : hidden).add(id);
  const keep = (row: Matrix['coreRows'][number] | Matrix['additionalRows'][number]) => shownRows.has(matrixRowKey(row));
  const coreRows = matrix.coreRows.filter(keep);
  const additionalRows = matrix.additionalRows.filter(keep);
  // A column stays when a shown row has something in it: the value, or the saved one beside it.
  const columns = matrix.columns.filter(col => [...coreRows, ...additionalRows].some(row => {
    const cell = matrix.cells.get(matrixCellKey(matrixRowKey(row), col.dateKey));
    return cell && cell.state !== 'empty';
  }));
  // Rows behind "Show all": hidden values, and rows that hold only the record's own values.
  const hiddenRows = matrix.coreRows.length + matrix.additionalRows.length - coreRows.length - additionalRows.length;
  return { matrix: { ...matrix, columns, coreRows, additionalRows }, shown, hidden, hiddenRows };
}

/** The `upload_review` row (US-13 AC13): counts only, never a value, test,
 *  unit or file. `changed` are the values cleared, edited or ticked to
 *  replace. A zero count is left out; `saved` is always sent. */
export function reviewEventMetadata(groups: ReviewGroups, changed: Iterable<string>, opened: { showAll: boolean; notSaved: boolean }, saved: boolean): Partial<Record<UploadReviewKey, number>> {
  let changedSure = 0;
  let changedUnsure = 0;
  for (const id of new Set(changed)) {
    const group = groups.groupOf.get(id);
    if (group === 'sure') changedSure++;
    else if (group === 'unsure') changedUnsure++;
  }
  const counts: Partial<Record<UploadReviewKey, number>> = {
    sure: groups.count('sure'), unsure: groups.count('unsure'), notSaved: groups.notSaved.total,
    showAll: Number(opened.showAll), notSavedOpened: Number(opened.notSaved), changedSure, changedUnsure,
  };
  return {
    ...Object.fromEntries(Object.entries(counts).filter(([, n]) => n).map(([k, n]) => [k, Math.min(n!, UPLOAD_OUTCOME_MAX)])),
    saved: Number(saved),
  };
}
