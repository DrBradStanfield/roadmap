/**
 * The website review's one call into health-core's import review (US-13 AC13).
 * Every group (sure, saved, unsure, not saved) comes from `classifyImportValues`;
 * this file only lays it over the matrix and counts it. The call lives here
 * alone, so a change to its signature is one edit.
 * Design: docs/drafts/import-review-redesign.md.
 */
import { classifyImportValues, importSummary, notSavedGroups, recordFromHistory, type ClassifiedValue, type ImportFile } from '@roadmap/health-core/import-review';
import { UPLOAD_OUTCOME_MAX, type UploadReviewKey } from '@roadmap/health-core/product-events';
import type { UploadHistory } from './api-types';
import { columnDay, parseReportDate, valueDate, type FullDate } from './review-dates';
import type { FileResult } from './upload-pipeline';
import { editId, matrixCellKey, matrixRowKey, type CoreCellView, type DateKey, type buildMatrixModel } from './review-matrix';

type Matrix = ReturnType<typeof buildMatrixModel>;
type Group = ClassifiedValue['group'];

/**
 * Each file as Save would send it (`ImportFile`): a document is not a lab
 * report; each value's day is the matrix's own (`valueDate`: its printed day,
 * its file's, or the one picked), null while it has none; an edited value
 * carries the number its cell saves (`views`). Every value is sent, as the
 * matrix places them all (`placeReadings` with `sent`); a cleared or unticked
 * one drops out at Save (`collectSaveableCells`).
 */
function importFiles(results: FileResult[], fileDates: Record<string, FullDate>, views: ReadonlyMap<string, CoreCellView>, edited: ReadonlySet<string>): ImportFile[] {
  return results.map((r, fi) => {
    const day = (recordedAt?: string) => {
      const date = valueDate(fileDates, fi, recordedAt);
      return date && !date.undated ? columnDay(date) : null;
    };
    /** The number an edited cell saves, in place of the extraction's; a limit only while untouched. */
    const typed = (ref: string) => (edited.has(`${fi}:${ref}`) ? views.get(`${fi}:${ref}`) : undefined);
    const values = r.values.map((v, i) => {
      const t = typed(`v${i}`);
      return t?.valueSI === undefined ? v : { ...v, valueSI: t.valueSI, comparator: t.comparator };
    });
    const additionalValues = r.additionalValues.map((v, i) => {
      const t = typed(`a${i}`);
      return t?.valueSI === undefined ? v : { ...v, value: t.valueSI, comparator: t.comparator };
    });
    const refs = [...values.map((_, i) => `v${i}`), ...additionalValues.map((_, i) => `a${i}`)];
    return {
      result: {
        classification: r.document && refs.length === 0 ? r.document.classification : 'lab_report',
        values: values as NonNullable<ImportFile['result']['values']>,
        additionalValues: additionalValues as NonNullable<ImportFile['result']['additionalValues']>,
        refusedValues: r.refusedValues,
        unreadValues: r.unreadValues,
        droppedValueCount: r.droppedValueCount,
        document: r.document as ImportFile['result']['document'],
      },
      days: Object.fromEntries([...r.values.map((v, i) => [`v${i}`, day(v.recordedAt)]), ...r.additionalValues.map((v, i) => [`a${i}`, day(v.recordedAt)])]),
      sent: new Set(refs),
      edited: new Set(refs.filter(ref => edited.has(`${fi}:${ref}`))),
    };
  });
}

/** What the review found and how each value is grouped, keyed as the matrix keys a value (`editId`). */
export function classifyReview(results: FileResult[], fileDates: Record<string, FullDate>, history: UploadHistory, views: ReadonlyMap<string, CoreCellView>, edited: ReadonlySet<string>) {
  const files = importFiles(results, fileDates, views, edited);
  const classified = classifyImportValues(files, recordFromHistory(history.measurements, history.labValues), new Date().toISOString());
  const groupOf = new Map<string, Group>(classified.map(v => [`${v.file}:${v.ref}`, v.group]));
  return {
    summary: importSummary(files),
    groupOf,
    count: (group: Group) => classified.filter(v => v.group === group).length,
    notSaved: notSavedGroups(classified),
  };
}
export type ReviewGroups = ReturnType<typeof classifyReview>;

/**
 * The rows the review shows by default: each row holding a value to look at.
 * The core's group decides (anything not sure); three guards keep a value that
 * would otherwise block or change Save in sight whatever the group says: a
 * conflict with a saved value (US-13 AC3), an error in the cell (US-13 AC5),
 * a column that needs or needed a day the report did not print, so a pick
 * never hides what it dated (US-13 AC8, US-12 AC14), and a value the person
 * edited, so an edit never hides its own row. Every value in a shown
 * row is shown; `hidden` are the rest, which save on Save as before.
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
