/**
 * The website review's one call into health-core's import review (US-13 AC13).
 * Every group (sure, saved, unsure, waiting, not saved) and every row Save
 * submits come from `classifyImportValues`; this file builds its input, lays
 * the groups over the matrix and counts them. The call lives here alone, so a
 * change to its signature is one edit.
 * Design: docs/drafts/import-review-redesign.md.
 */
import { classifyImportValues, importRow, importSummary, notSavedGroups, recordFromHistory, refusedAlone, type ClassifiedValue, type ImportFile } from '@roadmap/health-core/import-review';
import { UPLOAD_OUTCOME_MAX, type UploadReviewKey } from '@roadmap/health-core/product-events';
import type { BulkRow, LabUnitRefusal, MeasurementRefusal } from '@roadmap/health-core/record-edits';
import type { UploadHistory } from './api-types';
import { columnDay, parseReportDate, valueDate, type FullDate } from './review-dates';
import type { FileResult, ReviewedLabValue, ReviewedValue } from './upload-pipeline';
import { editId, matrixCellKey, matrixRowKey, type CoreCellView, type DateKey, type buildMatrixModel } from './review-matrix';
import { UNIT_DEFS, type MetricType } from '@roadmap/health-core/units';
import { cellNumber, cellToSI, readNumericCell, readTypedValue, type CellUnit } from './blood-test-cell';

type Matrix = ReturnType<typeof buildMatrixModel>;
type Group = ClassifiedValue['group'];

/** A value Save would send as the person left it, by `editId`: the day it is
 *  written on, a ticked Replace's row, and the number typed over it, if any. */
export interface KeptValue { id: string; recordedAt: string; correctsId?: string; edited?: number }


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
const refAt = (id: string) => ({ fi: Number(id.slice(0, id.indexOf(':'))), ref: id.slice(id.indexOf(':') + 1) });

/**
 * The number each edited value saves now, by `editId`, as Save reads it: a
 * core value in SI from the unit it was typed in, a lab as typed; null for a
 * cleared one. Text that renders the extraction, or no number yet, is left
 * out (Save takes the extraction, or the cell's error blocks it). The matrix
 * places by these and the review's groups classify them, so both judge the
 * table as it stands (US-13 AC13).
 */
export function currentEdits(results: FileResult[], texts: Readonly<Record<string, string>>, touched: ReadonlyMap<string, { display?: CellUnit }>,
  units: Partial<Record<MetricType, CellUnit>>, unitSystem: CellUnit): Map<string, number | null> {
  const edits = new Map<string, number | null>();
  for (const [id, { display }] of touched) {
    const text = texts[id]?.trim();
    if (text === undefined) continue;
    if (text === '') { edits.set(id, null); continue; }
    const { fi, ref } = refAt(id);
    const i = Number(ref.slice(1));
    let value: number | undefined;
    if (ref[0] === 'v') {
      const v = results[fi]?.values[i];
      const metric = v?.metric as MetricType;
      if (!v) continue;
      if (UNIT_DEFS[metric]) {
        const typedIn = display ?? units[metric] ?? unitSystem;
        if (text === cellNumber(metric, v.valueSI, typedIn, v.comparator)) continue;
        const typed = readTypedValue(metric, text, typedIn);
        value = typed === undefined ? undefined : cellToSI(metric, typed, typedIn);
      } else value = text === String(v.displayValue) ? undefined : readNumericCell(text);
    } else {
      const av = results[fi]?.additionalValues[i];
      value = !av || text === String(av.value) ? undefined : readNumericCell(text);
    }
    if (value !== undefined) edits.set(id, value);
  }
  return edits;
}

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

/** The kept values the write refuses on their own, judged on the payload Save
 *  would send (each `KeptValue`'s own number), by `editId`. */
export function refusedKeptIds(results: FileResult[], kept: readonly KeptValue[]): Set<string> {
  const now = new Date().toISOString();
  return new Set(kept.filter((k) => {
    const { fi, ref } = refAt(k.id);
    // Any real day, as in `slotlessIds`: a refusal on its own never depends on the day.
    const row = results[fi] && importRow(extraction(results[fi]), ref, '2000-01-01', k.edited === undefined ? {} : { edited: { value: k.edited } });
    return !!row && refusedAlone(row, now);
  }).map((k) => k.id));
}

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
      const { fi: file, ref } = refAt(k.id);
      if (file !== fi) continue;
      const row = importRow(result, ref, k.recordedAt, { correctsId: k.correctsId, ...(k.edited !== undefined ? { edited: { value: k.edited } } : null) });
      if (row) { rows[ref] = row; source.set(row, k); }
    }
    return { result, rows, days: Object.fromEntries([...r.values.map((v, i) => [`v${i}`, day(v.recordedAt)]), ...r.additionalValues.map((v, i) => [`a${i}`, day(v.recordedAt)])]) };
  });
  const { values: classified, rows } = classifyImportValues(files, recordFromHistory(history.measurements, history.labValues), new Date().toISOString());
  const id = (v: ClassifiedValue) => `${v.file}:${v.ref}`;
  /** A kept value the write would refuse: Save stays blocked until it is corrected or cleared (US-13 AC5). */
  const refused = classified.filter(v => v.sent && !v.writes && (v.group === 'unsure' ? v.reasons.includes('outOfRange') : v.group === 'notSaved' && v.reason !== 'sameDay'));
  return {
    summary: importSummary(files),
    groupOf: new Map<string, Group>(classified.map(v => [id(v), v.group])),
    /** The values Save writes, by `editId`. */
    writes: new Set(classified.filter(v => v.writes).map(id)),
    count: (group: Group) => classified.filter(v => v.group === group).length,
    /** Values the record already holds; an equal reading of this upload is counted nowhere (one copy saves). */
    held: classified.filter(v => v.group === 'saved' && !v.duplicate).length,
    notSaved: notSavedGroups(classified),
    decisions: toDecisions(rows, source, results),
    blocked: new Set(refused.map(id)),
    /** The write's own refusal of a kept core value (`ImportRefusal`), for its cell's line. */
    refusals: new Map(refused.flatMap(v => (v.refusal && 'measurement' in v.refusal ? [[id(v), v.refusal.measurement] as [string, MeasurementRefusal]] : []))),
    /** Labs not saved for their unit or number, for the refused-spelling count when Save finishes (US-21 AC15). */
    labRefusals: classified.flatMap((v): LabUnitRefusal[] => (v.group === 'notSaved' && v.refusal && 'lab' in v.refusal ? [v.refusal.lab] : [])),
  };
}
export type ReviewGroups = ReturnType<typeof classifyReview>;

/** The rows Save submits, in the write's order, as the review's decisions
 *  (`ReviewDecisions`). A lab keeps its reference range as extracted. */
function toDecisions(rows: readonly BulkRow[], source: ReadonlyMap<BulkRow, KeptValue>, results: FileResult[]): { values: ReviewedValue[]; labValues: ReviewedLabValue[] } {
  const values: ReviewedValue[] = [];
  const labValues: ReviewedLabValue[] = [];
  for (const row of rows) {
    const { fi, ref } = refAt(source.get(row)!.id);
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
