/**
 * The website review's one call into health-core's import review (US-13 AC13).
 * Every group (sure, saved, unsure, waiting, not saved) and every row Save
 * submits come from `classifyImportValues`; this file builds its input, lays
 * the groups over the matrix and counts them. The call lives here alone, so a
 * change to its signature is one edit.
 * Design: docs/drafts/import-review-redesign.md.
 */
import { classifyImportValues, importRow, importSummary, notSavedGroups, recordFromHistory, type ClassifiedValue, type ImportFile } from '@roadmap/health-core/import-review';
import { UPLOAD_OUTCOME_MAX, type UploadReviewKey } from '@roadmap/health-core/product-events';
import type { BulkRow } from '@roadmap/health-core/record-edits';
import type { UploadHistory } from './api-types';
import { columnDay, parseReportDate, valueDate, type FullDate } from './review-dates';
import type { FileResult, ReviewedLabValue, ReviewedValue } from './upload-pipeline';
import { editId, matrixCellKey, matrixRowKey, type CoreCellView, type DateKey, type buildMatrixModel } from './review-matrix';

type Matrix = ReturnType<typeof buildMatrixModel>;
type Group = ClassifiedValue['group'];

/** A value Save would send as the person left it, by `editId`: the day it is
 *  written on, a ticked Replace's row, and the number typed over it, if any. */
export interface KeptValue { id: string; recordedAt: string; correctsId?: string; edited?: number }

/** `editId` → its file and its ref in the extraction. */
const place = (id: string) => ({ fi: Number(id.slice(0, id.indexOf(':'))), ref: id.slice(id.indexOf(':') + 1) });

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

/**
 * The review's groups and what Save submits. Each kept cell is a row built by
 * health-core's `importRow` (a ticked Replace carries its `correctsId`, an
 * edit its number); a cleared cell or an unticked conflict has no row, and is
 * judged on its day, the matrix's own (`valueDate`), null while it has none.
 * `classifyImportValues` runs the real save dry and returns the rows that
 * write; Save hands up exactly those (`decisions`).
 */
export function classifyReview(results: FileResult[], fileDates: Record<string, FullDate>, history: UploadHistory, kept: readonly KeptValue[]) {
  const source = new Map<BulkRow, KeptValue>();
  const files: ImportFile[] = results.map((r, fi) => {
    const result = extraction(r);
    const day = (recordedAt?: string) => {
      const date = valueDate(fileDates, fi, recordedAt);
      return date && !date.undated ? columnDay(date) : null;
    };
    const rows: Record<string, BulkRow> = {};
    for (const k of kept) {
      const { fi: file, ref } = place(k.id);
      if (file !== fi) continue;
      const row = importRow(result, ref, k.recordedAt, { correctsId: k.correctsId, ...(k.edited !== undefined ? { edited: { value: k.edited } } : null) });
      if (row) { rows[ref] = row; source.set(row, k); }
    }
    return { result, rows, days: Object.fromEntries([...r.values.map((v, i) => [`v${i}`, day(v.recordedAt)]), ...r.additionalValues.map((v, i) => [`a${i}`, day(v.recordedAt)])]) };
  });
  const { values: classified, rows } = classifyImportValues(files, recordFromHistory(history.measurements, history.labValues), new Date().toISOString());
  return {
    summary: importSummary(files),
    groupOf: new Map<string, Group>(classified.map(v => [`${v.file}:${v.ref}`, v.group])),
    /** The values Save writes, by `editId`. */
    writes: new Set(classified.filter(v => v.writes).map(v => `${v.file}:${v.ref}`)),
    count: (group: Group) => classified.filter(v => v.group === group).length,
    notSaved: notSavedGroups(classified),
    decisions: toDecisions(rows, source, results),
  };
}
export type ReviewGroups = ReturnType<typeof classifyReview>;

/** The rows Save submits, in the write's order, as the review's decisions
 *  (`ReviewDecisions`). A lab keeps its reference range as extracted. */
function toDecisions(rows: readonly BulkRow[], source: ReadonlyMap<BulkRow, KeptValue>, results: FileResult[]): { values: ReviewedValue[]; labValues: ReviewedLabValue[] } {
  const values: ReviewedValue[] = [];
  const labValues: ReviewedLabValue[] = [];
  for (const row of rows) {
    const { fi, ref } = place(source.get(row)!.id);
    const limit = row.comparator ? { comparator: row.comparator } : {};
    if (row.kind === 'measurement') {
      values.push({ metric: row.metricType, valueSI: row.value, recordedAt: row.recordedAt, source: row.source === 'lab_import_edited' ? row.source : undefined, correctsId: row.correctsId, ...limit });
    } else {
      const av = results[fi].additionalValues[Number(ref.slice(1))];
      labValues.push({ name: row.metricName, value: row.value, unit: row.unit, referenceLow: av.referenceLow, referenceHigh: av.referenceHigh, recordedAt: row.recordedAt, correctsId: row.correctsId, ...limit });
    }
  }
  return { values, labValues };
}

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
  return { matrix: { ...matrix, columns, coreRows, additionalRows }, shown, hidden };
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
