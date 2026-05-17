import { useState, useMemo, useEffect, useCallback, useRef, memo } from 'react';
import type { UnitSystem, MetricType, MeasurementSource, ApiMeasurement, DocumentType } from '@roadmap/health-core';
import {
  toCanonicalValue,
  UNIT_DEFS,
  METRIC_LABELS,
  formatDisplayValue,
  getDisplayLabel,
  parseLocalisedNumber,
  BLOOD_TEST_METRICS,
  refHintFor,
  isScreeningEligible,
} from '@roadmap/health-core';
import { getCurrentDateValue } from './DatePicker';
import type { ExtractedValue, AdditionalLabValue, ApiDocument, ApiLabValue, DocumentResult, UploadHistory } from '../lib/api';
import { labValueLabel } from '../lib/lab-value-labels';
import { useMatrixScrollSync } from '../lib/useMatrixScrollSync';
import { NumericInputCell } from './NumericInputCell';
import { DraftDateCell } from './DraftDateCell';
import { MONTHS_SHORT } from '../lib/constants';

export interface FileResult {
  fileName: string;
  reportDate: string | null;
  values: ExtractedValue[];
  additionalValues: AdditionalLabValue[];
  error?: string;
  /** Present for non-lab documents (scan results, clinic letters, etc.) */
  document?: DocumentResult;
}

/** Document to be saved, assembled from review state */
export interface DocumentToSave {
  documentType: string;
  title: string;
  documentDate: string | null;
  contentMd: string;
  metadata: Record<string, unknown>;
  sourceFileName: string | null;
  /** If this maps to a screening type, the key to update (e.g. "colorectal_last_date") */
  screeningUpdate?: { key: string; date: string };
}

interface ReviewTableProps {
  results: FileResult[];
  history: UploadHistory;
  unitSystem: UnitSystem;
  birthYear?: number;
  sex?: 'male' | 'female';
  onSave: (payload: {
    values: Array<{ metric: string; valueSI: number; recordedAt: string; source?: MeasurementSource }>;
    documents: DocumentToSave[];
    labValues: Array<{ name: string; value: number; unit: string; referenceLow?: number | null; referenceHigh?: number | null; recordedAt: string }>;
  }) => void;
  onCancel: () => void;
  isSaving: boolean;
  error: string | null;
}

/** Full date state: day/month/year. Day is null when the LLM didn't extract one. */
interface FullDate {
  day: string | null; // "01"-"31" or null
  month: string;      // "1"-"12"
  year: string;       // "2024"
}

function parseReportDate(dateStr: string | null): FullDate {
  if (!dateStr) {
    const now = getCurrentDateValue();
    return { day: null, month: now.month, year: now.year };
  }
  const parts = dateStr.split('-');
  const now = getCurrentDateValue();
  return {
    day: parts.length >= 3 ? parts[2] : null,
    month: parts[1] || now.month,
    year: parts[0] || now.year,
  };
}

function getDaysInMonth(month: string, year: string): number {
  return new Date(parseInt(year), parseInt(month), 0).getDate();
}

/** Build YYYY-MM-DD or YYYY-MM-01 ISO string from FullDate state. */
function buildRecordedAt(date: FullDate): string {
  const month = date.month.padStart(2, '0');
  const day = date.day ? date.day.padStart(2, '0') : '01';
  return `${date.year}-${month}-${day}T00:00:00.000Z`;
}

/** Build the most precise date prefix for duplicate matching. */
function buildDatePrefix(date: FullDate): string {
  const month = date.month.padStart(2, '0');
  if (date.day) {
    return `${date.year}-${month}-${date.day.padStart(2, '0')}`;
  }
  return `${date.year}-${month}`;
}

/** Title is normalised (lower + trim) so capitalisation drift across
 *  re-uploads doesn't break the check. */
function buildDocHistoryIndex(history: ApiDocument[]): Set<string> {
  const idx = new Set<string>();
  for (const d of history) {
    if (!d.documentDate) continue;
    idx.add(`${d.title.trim().toLowerCase()}|${d.documentDate}`);
  }
  return idx;
}

function isDocDuplicate(title: string, documentDate: string | null, idx: Set<string>): boolean {
  if (!documentDate) return false;
  return idx.has(`${title.trim().toLowerCase()}|${documentDate}`);
}

/** Lab-value name → cell key. Lower + trim for dedup, and strip `|`
 *  because the cellKey format is `${rowKey}|${dateKey}` — an LLM-emitted
 *  name like "ALT | AST ratio" would otherwise collide. */
function normaliseLabName(name: string): string {
  return name.trim().toLowerCase().replace(/\|/g, '/');
}

// ============================================================================
// Matrix model — review-time blood-test values rendered as a metric × date
// grid. Replaces the per-file row layout. Existing history acts as greyed-out
// context columns; new upload values are editable per cell. Documents render
// below the matrix in per-file cards (unchanged).
// ============================================================================

type DateKey = string; // YYYY-MM-DD or YYYY-MM

interface MatrixColumn {
  dateKey: DateKey;     // sort key, also rendered as the column header
  date: FullDate;       // mutable for new columns; sourced from history for existing
  isNew: boolean;       // false = history-only; true = at least one upload contributes
  fileIndices: number[]; // upload files at this date (empty for history-only columns)
}

interface CoreRow {
  kind: 'core';
  metric: MetricType;
}

interface AdditionalRow {
  kind: 'additional';
  /** Normalised key (lower + trim) used for dedup. Display uses any case from the data. */
  nameKey: string;
  /** Display name — preserves casing from the first source we see. */
  displayName: string;
  /** Stable unit from the first source we see. */
  unit: string;
  referenceLow: number | null;
  referenceHigh: number | null;
}

type MatrixRow = CoreRow | AdditionalRow;

/** Editable matrix cell. Discriminated by `kind` so the save logic can
 *  resolve back to the right source array (r.values[vi] vs
 *  r.additionalValues[ai]) without a sign-encoding trick. */
type EditableMatrixCell =
  | { state: 'editable'; kind: 'core'; fi: number; vi: number; initialDisplay: string; confidence: 'high' | 'medium' | 'low'; valueSI: number; displayUnit: string }
  | { state: 'editable'; kind: 'additional'; fi: number; ai: number; initialDisplay: string; valueSI: number; displayUnit: string };

type MatrixCell =
  | { state: 'empty' }
  | { state: 'context'; displayValue: string }
  | EditableMatrixCell;

/** Build the matrix view. Existing rows win the cell (per-cell dedup — the
 *  LLM-extracted value at the same (metric, date) is discarded; user can
 *  click-to-correct in the live timeline if they want to update). */
function buildMatrixModel(
  results: FileResult[],
  fileDates: Record<number, FullDate>,
  bloodTestHistory: ApiMeasurement[],
  labValueHistory: ApiLabValue[],
  unitSystem: UnitSystem,
): { columns: MatrixColumn[]; coreRows: CoreRow[]; additionalRows: AdditionalRow[]; cells: Map<string, MatrixCell> } {
  const cells = new Map<string, MatrixCell>();
  const columnsByKey = new Map<DateKey, MatrixColumn>();
  const coreMetricsSeen = new Set<MetricType>();
  const additionalByKey = new Map<string, AdditionalRow>();

  const addColumn = (dateKey: DateKey, date: FullDate, fileIndex: number | null) => {
    let col = columnsByKey.get(dateKey);
    if (!col) {
      col = { dateKey, date, isNew: fileIndex !== null, fileIndices: [] };
      columnsByKey.set(dateKey, col);
    }
    if (fileIndex !== null) {
      col.isNew = true;
      if (!col.fileIndices.includes(fileIndex)) col.fileIndices.push(fileIndex);
    }
    return col;
  };

  // 1) Seed columns + cells from existing history (greyed context).
  const bloodTestSet = new Set<string>(BLOOD_TEST_METRICS);
  for (const m of bloodTestHistory) {
    if (!bloodTestSet.has(m.metricType)) continue;
    const dateKey = m.recordedAt.slice(0, 10);
    addColumn(dateKey, parseReportDate(dateKey), null);
    const metric = m.metricType as MetricType;
    coreMetricsSeen.add(metric);
    const display = UNIT_DEFS[metric]
      ? formatDisplayValue(metric, m.value, unitSystem)
      : String(m.value);
    cells.set(`${metric}|${dateKey}`, { state: 'context', displayValue: display });
  }
  for (const lv of labValueHistory) {
    const dateKey = lv.recordedAt.slice(0, 10);
    addColumn(dateKey, parseReportDate(dateKey), null);
    const nameKey = normaliseLabName(lv.metricName);
    if (!additionalByKey.has(nameKey)) {
      additionalByKey.set(nameKey, {
        kind: 'additional',
        nameKey,
        displayName: labValueLabel(lv.metricName),
        unit: lv.unit,
        referenceLow: lv.referenceLow,
        referenceHigh: lv.referenceHigh,
      });
    }
    cells.set(`${nameKey}|${dateKey}`, { state: 'context', displayValue: `${lv.value} ${lv.unit}` });
  }

  // 2) Overlay upload values. Context already-saved cells win — discard the
  //    LLM value at that (metric, date) silently (user can click-to-correct
  //    in the live timeline if they want to update the saved value).
  results.forEach((r, fi) => {
    const fdate = fileDates[fi];
    if (!fdate) return;
    const dateKey = buildDatePrefix(fdate);
    addColumn(dateKey, fdate, fi);

    r.values.forEach((v, vi) => {
      const metric = v.metric as MetricType;
      coreMetricsSeen.add(metric);
      const cellKey = `${metric}|${dateKey}`;
      if (cells.has(cellKey)) return; // existing history wins
      const initialDisplay = UNIT_DEFS[metric]
        ? formatDisplayValue(metric, v.valueSI, unitSystem)
        : String(v.displayValue);
      cells.set(cellKey, {
        state: 'editable', kind: 'core', fi, vi,
        initialDisplay,
        confidence: v.confidence,
        valueSI: v.valueSI,
        displayUnit: v.displayUnit,
      });
    });

    r.additionalValues.forEach((av, ai) => {
      const nameKey = normaliseLabName(av.name);
      if (!additionalByKey.has(nameKey)) {
        additionalByKey.set(nameKey, {
          kind: 'additional',
          nameKey,
          displayName: labValueLabel(av.name),
          unit: av.unit,
          referenceLow: av.referenceLow ?? null,
          referenceHigh: av.referenceHigh ?? null,
        });
      }
      const cellKey = `${nameKey}|${dateKey}`;
      if (cells.has(cellKey)) return;
      cells.set(cellKey, {
        state: 'editable',
        kind: 'additional',
        fi, ai,
        // Number only. The unit is rendered separately as a chip on the
        // row label (describeRow.unitLabel), and we still need parseLocalisedNumber
        // to succeed on the cell value at save time.
        initialDisplay: String(av.value),
        valueSI: av.value,
        displayUnit: av.unit,
      });
    });
  });

  // 3) Sort. Columns chronological asc (oldest left, newest right).
  //    Core rows in the canonical BLOOD_TEST_METRICS order so the matrix
  //    reads the same as the live timeline. Additional rows alphabetic.
  const columns = Array.from(columnsByKey.values()).sort((a, b) => a.dateKey.localeCompare(b.dateKey));
  const coreRows: CoreRow[] = BLOOD_TEST_METRICS
    .filter(m => coreMetricsSeen.has(m as MetricType))
    .map(m => ({ kind: 'core' as const, metric: m as MetricType }));
  const additionalRows = Array.from(additionalByKey.values()).sort((a, b) =>
    a.displayName.localeCompare(b.displayName),
  );

  return { columns, coreRows, additionalRows, cells };
}

/** Cell key for the matrix model (used by both the cells Map and the
 *  per-cell edit state). */
function matrixCellKey(rowKey: string, dateKey: DateKey): string {
  return `${rowKey}|${dateKey}`;
}

/** Row's stable key for cell lookups. */
function matrixRowKey(row: MatrixRow): string {
  return row.kind === 'core' ? row.metric : row.nameKey;
}

/** Order in which document type sections render: scans, then letters,
 *  then other admin docs. Exhaustive over DocumentType so a typo (or a
 *  new enum value added without ordering) is a compile error, not a
 *  silent fall-through to the bottom of the list. */
const DOC_TYPE_ORDER: Record<DocumentType, number> = {
  scan_result: 0,
  clinic_letter: 1,
  discharge_summary: 2,
  pathology_report: 3,
  vaccination_record: 4,
  other: 99,
};

export function ReviewTable({
  results,
  history,
  unitSystem,
  birthYear,
  sex,
  onSave,
  onCancel,
  isSaving,
  error,
}: ReviewTableProps) {
  const userAge = birthYear ? new Date().getFullYear() - birthYear : undefined;
  const docHistoryIndex = useMemo(() => buildDocHistoryIndex(history.documents), [history.documents]);

  // Per-file full date state (day/month/year)
  const [fileDates, setFileDates] = useState<Record<number, FullDate>>(() => {
    const dates: Record<number, FullDate> = {};
    results.forEach((r, i) => { dates[i] = parseReportDate(r.reportDate); });
    return dates;
  });

  // Render order: value-only files first, then document-bearing files
  // grouped by type (scans → letters → other) and within type by date desc.
  // Errored files go last. Each entry keeps its original index so all the
  // per-row state (`checked`, `fileDates`, …) keys stay stable.
  const sortedResults = useMemo(() =>
    results.map((r, fi) => ({ r, fi })).sort((a, b) => {
      const aErr = a.r.error ? 2 : 0;
      const bErr = b.r.error ? 2 : 0;
      if (aErr !== bErr) return aErr - bErr;
      const aDoc = a.r.document ? DOC_TYPE_ORDER[a.r.document.classification] : -1;
      const bDoc = b.r.document ? DOC_TYPE_ORDER[b.r.document.classification] : -1;
      if (aDoc !== bDoc) return aDoc - bDoc;
      const aDate = a.r.document?.documentDate ?? '';
      const bDate = b.r.document?.documentDate ?? '';
      return bDate.localeCompare(aDate);
    }),
    [results],
  );

  // Per-document: whether to save this document. Default: checked for new
  // documents, UNCHECKED for documents that already exist at the same
  // (title, documentDate) — same UX as the measurement dup-check.
  const [docChecked, setDocChecked] = useState<Record<number, boolean>>(() => {
    const map: Record<number, boolean> = {};
    results.forEach((r, fi) => {
      if (!r.document) return;
      const dup = isDocDuplicate(r.document.title, r.document.documentDate, docHistoryIndex);
      map[fi] = !dup;
    });
    return map;
  });

  // Per-document: editable title
  const [docTitles, setDocTitles] = useState<Record<number, string>>(() => {
    const map: Record<number, string> = {};
    results.forEach((r, fi) => { if (r.document) map[fi] = r.document.title; });
    return map;
  });

  // Per-document: whether to update screening date (when screeningType is present AND user is old enough)
  const [screeningChecked, setScreeningChecked] = useState<Record<number, boolean>>(() => {
    const map: Record<number, boolean> = {};
    results.forEach((r, fi) => {
      const st = r.document?.metadata?.screeningType as string | undefined;
      if (st && isScreeningEligible(st, userAge, sex)) {
        map[fi] = true;
      }
    });
    return map;
  });

  // The matrix model is the source of truth for what's rendered + what's
  // saveable. Cells in `context` state come from history (greyed, no edit);
  // `editable` cells come from this upload. Save selection = an editable
  // cell whose `editedDisplayValues` entry is non-empty (clear-to-skip).
  const matrix = useMemo(
    () => buildMatrixModel(results, fileDates, history.bloodTests, history.labValues, unitSystem),
    [results, fileDates, history.bloodTests, history.labValues, unitSystem],
  );

  // Initial display values are derived from the matrix (not from raw results)
  // so the unit-system switch re-formats them and dedup-collapsed cells
  // (LLM value silently dropped where history wins) don't appear here.
  const initialDisplayValues = useMemo<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    for (const [cellKey, cell] of matrix.cells) {
      if (cell.state === 'editable') map[cellKey] = cell.initialDisplay;
    }
    return map;
  }, [matrix]);

  const [editedDisplayValues, setEditedDisplayValues] = useState<Record<string, string>>(
    () => ({ ...initialDisplayValues }),
  );
  // Tracks which cells the user has touched. Used by the reformat effect
  // below to distinguish "user edited this — keep their text" from "untouched —
  // re-seed with the freshly-formatted initial value when unit system flips."
  const userEditedKeysRef = useRef<Set<string>>(new Set());

  const updateEditedDisplayValue = useCallback((cellKey: string, value: string) => {
    userEditedKeysRef.current.add(cellKey);
    setEditedDisplayValues(prev => ({ ...prev, [cellKey]: value }));
  }, []);

  // Reformat on unit-system switch + pick up newly-editable cells when a
  // date change reshapes the matrix. User-touched cells keep their text;
  // untouched cells get re-seeded from the (re-formatted) initial; cells
  // that vanished from the model drop out.
  useEffect(() => {
    setEditedDisplayValues(prev => {
      const next: Record<string, string> = {};
      const touched = userEditedKeysRef.current;
      for (const cellKey of Object.keys(initialDisplayValues)) {
        next[cellKey] = touched.has(cellKey) && prev[cellKey] !== undefined
          ? prev[cellKey]
          : initialDisplayValues[cellKey];
      }
      // Prune the touched set so it can't grow unbounded across re-uploads.
      for (const k of touched) if (!(k in initialDisplayValues)) touched.delete(k);
      return next;
    });
  }, [initialDisplayValues]);

  // Document dedup auto-uncheck (unchanged behaviour from pre-matrix).
  // makes a doc match an existing saved doc. Never re-checks (user can
  // manually re-tick if they want to save a same-title dup).
  useEffect(() => {
    setDocChecked(prev => {
      let changed = false;
      const next = { ...prev };
      results.forEach((r, fi) => {
        if (!r.document || !prev[fi]) return;
        const title = docTitles[fi] ?? r.document.title;
        const date = buildRecordedAt(fileDates[fi]).slice(0, 10); // YYYY-MM-DD
        if (isDocDuplicate(title, date, docHistoryIndex)) {
          next[fi] = false;
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [fileDates, docTitles, results, docHistoryIndex]);

  /** Walks the matrix cells, returns the editable ones with a non-empty
   *  edited display value — the cells that will save. Shared by both the
   *  summary counts and handleSave so they stay in sync. */
  const collectSaveableCells = () => {
    interface CellPayload {
      cellKey: string;
      dateKey: DateKey;
      cell: EditableMatrixCell;
      parsed: number;
      isEdited: boolean;
    }
    const out: CellPayload[] = [];
    for (const [cellKey, cell] of matrix.cells) {
      if (cell.state !== 'editable') continue;
      const editedStr = (editedDisplayValues[cellKey] ?? cell.initialDisplay).trim();
      if (!editedStr) continue;
      const parsed = parseLocalisedNumber(editedStr);
      if (parsed === undefined) continue;
      // dateKey is the suffix after the LAST `|` — robust against the
      // (rare) chance the rowKey itself contains a separator.
      const dateKey = cellKey.slice(cellKey.lastIndexOf('|') + 1);
      out.push({ cellKey, dateKey, cell, parsed, isEdited: editedStr !== cell.initialDisplay });
    }
    return out;
  };

  const saveableCells = useMemo(collectSaveableCells, [matrix, editedDisplayValues]);
  const selectedCount = useMemo(() => saveableCells.filter(c => c.cell.kind === 'core').length, [saveableCells]);
  const selectedAdditionalCount = useMemo(() => saveableCells.filter(c => c.cell.kind === 'additional').length, [saveableCells]);
  const totalEditableCells = useMemo(() => {
    let n = 0;
    for (const cell of matrix.cells.values()) if (cell.state === 'editable') n++;
    return n;
  }, [matrix]);
  const selectedDocCount = useMemo(() => Object.values(docChecked).filter(Boolean).length, [docChecked]);

  /** A column with no date isn't saveable. Existing-history columns always
   *  have a YYYY-MM-DD date; new (upload) columns require day+month+year so
   *  dedup against history matches exactly (a month-only upload would
   *  silently synthesise day=01 and either duplicate or miss-match). */
  const allDatesSet = useMemo(() => matrix.columns.every(col => {
    if (!col.isNew) return true;
    return !!(col.date.year && col.date.month && col.date.day);
  }), [matrix.columns]);

  /** Column-level date editing: propagate to every contributing file so the
   *  matrix stays consistent. New-column dates only — existing-history
   *  columns are read-only (correction goes through the live timeline). */
  const handleColumnDateChange = (col: MatrixColumn, update: Partial<FullDate>) => {
    if (!col.isNew) return;
    setFileDates(prev => {
      const next = { ...prev };
      for (const fi of col.fileIndices) {
        const merged = { ...prev[fi], ...update };
        if (merged.day) {
          const maxDay = getDaysInMonth(merged.month, merged.year);
          if (parseInt(merged.day) > maxDay) merged.day = String(maxDay);
        }
        next[fi] = merged;
      }
      return next;
    });
  };

  const handleSave = () => {
    // Collect core lab values
    const selected: Array<{ metric: string; valueSI: number; recordedAt: string; source?: MeasurementSource }> = [];
    const selectedLabValues: Array<{ name: string; value: number; unit: string; referenceLow?: number | null; referenceHigh?: number | null; recordedAt: string }> = [];

    // O(1) column lookup so save doesn't go quadratic on big uploads.
    const columnsByKey = new Map(matrix.columns.map(col => [col.dateKey, col]));

    for (const c of saveableCells) {
      const col = columnsByKey.get(c.dateKey);
      if (!col) continue;
      const recordedAt = buildRecordedAt(col.date);
      const cell = c.cell;
      if (cell.kind === 'core') {
        const metric = results[cell.fi]?.values[cell.vi]?.metric as MetricType | undefined;
        if (!metric) continue;
        const valueSI = UNIT_DEFS[metric]
          ? toCanonicalValue(metric, c.parsed, unitSystem)
          : c.parsed;
        selected.push({
          metric,
          valueSI,
          recordedAt,
          source: c.isEdited ? 'lab_import_edited' : undefined,
        });
      } else {
        const av = results[cell.fi]?.additionalValues[cell.ai];
        if (!av) continue;
        selectedLabValues.push({
          name: av.name,
          value: c.isEdited ? c.parsed : av.value,
          unit: av.unit,
          referenceLow: av.referenceLow,
          referenceHigh: av.referenceHigh,
          recordedAt,
        });
      }
    }

    // Collect documents
    const documents: DocumentToSave[] = [];
    results.forEach((r, fi) => {
      if (!r.document || !docChecked[fi]) return;
      const date = fileDates[fi];
      const dateStr = date.year && date.month
        ? `${date.year}-${date.month.padStart(2, '0')}${date.day ? '-' + date.day.padStart(2, '0') : '-01'}`
        : null;

      const screeningType = r.document.metadata?.screeningType as string | undefined;
      const screeningKey = screeningType ? `${screeningType}_last_date` : undefined;

      documents.push({
        documentType: r.document.classification,
        title: docTitles[fi] || r.document.title,
        documentDate: dateStr,
        contentMd: r.document.contentMarkdown,
        metadata: r.document.metadata,
        sourceFileName: r.fileName,
        screeningUpdate: screeningKey && screeningChecked[fi] && dateStr
          ? { key: screeningKey, date: dateStr }
          : undefined,
      });
    });

    onSave({ values: selected, documents, labValues: selectedLabValues });
  };

  return (
    <div className="review-table">
      <div className="review-summary">
        {selectedCount > 0 && `${selectedCount} value${selectedCount !== 1 ? 's' : ''}`}
        {selectedCount > 0 && selectedAdditionalCount > 0 && ' + '}
        {selectedAdditionalCount > 0 && `${selectedAdditionalCount} additional`}
        {(selectedCount > 0 || selectedAdditionalCount > 0) && selectedDocCount > 0 && ' + '}
        {selectedDocCount > 0 && `${selectedDocCount} document${selectedDocCount !== 1 ? 's' : ''}`}
        {selectedCount === 0 && selectedAdditionalCount === 0 && selectedDocCount === 0 && 'No items selected'}
        {' '}from {results.length} file{results.length !== 1 ? 's' : ''} · {totalEditableCells} extracted
      </div>

      {(matrix.coreRows.length > 0 || matrix.additionalRows.length > 0) && (
        <ReviewMatrix
          matrix={matrix}
          unitSystem={unitSystem}
          sex={sex}
          editedDisplayValues={editedDisplayValues}
          onCellChange={updateEditedDisplayValue}
          onColumnDateChange={handleColumnDateChange}
        />
      )}

      {sortedResults.map(({ r, fi }) => {
        // After the matrix, the per-file section only renders for:
        //   - documents (scan results, clinic letters, …)
        //   - error rows (file failed to parse)
        //   - value-only files with NOTHING shown by the matrix (rare, e.g.
        //     LLM returned `values:[]` and `additionalValues:[]` — show
        //     "No values found" so the upload doesn't appear ignored).
        const hasNothingForMatrix = !r.error && !r.document && r.values.length === 0 && r.additionalValues.length === 0;
        if (!r.error && !r.document && !hasNothingForMatrix) return null;

        const date = fileDates[fi];
        const docTitle = r.document ? (docTitles[fi] ?? r.document.title) : '';
        const docDateIso = r.document ? buildRecordedAt(date).slice(0, 10) : null;
        const isDocDup = r.document ? isDocDuplicate(docTitle, docDateIso, docHistoryIndex) : false;

        return (
          <div key={fi} className="review-file-section">
            <div className="review-file-header">
              <span className="review-file-name">{r.fileName}</span>
            </div>

            {r.error ? (
              <p className="review-file-error">Could not read this file: {r.error}</p>
            ) : r.document ? (
              <div className="review-document-card">
                <div className="review-document-header">
                  <label className="review-row-check">
                    <input
                      type="checkbox"
                      checked={docChecked[fi] ?? false}
                      onChange={(e) => setDocChecked(prev => ({ ...prev, [fi]: e.target.checked }))}
                    />
                  </label>
                  <span className={`review-doc-type-badge review-doc-type--${r.document.classification}`}>
                    {r.document.classification.replace(/_/g, ' ')}
                  </span>
                  {isDocDup && <span className="review-row-dup">Already saved</span>}
                </div>

                <div className="review-document-title">
                  <input
                    type="text"
                    value={docTitles[fi] || ''}
                    onChange={(e) => setDocTitles(prev => ({ ...prev, [fi]: e.target.value }))}
                    className="review-title-input"
                    placeholder="Document title"
                  />
                </div>

                <div className="review-file-date">
                  <span>Date:</span>
                  <DraftDateCell
                    date={`${date.year}-${date.month.padStart(2, '0')}-${(date.day ?? '01').padStart(2, '0')}`}
                    needsDay={!date.day}
                    ariaLabel="Document date"
                    onChange={picked => {
                      const [y, m, d] = picked.split('-');
                      if (y && m && d) setFileDates(prev => ({ ...prev, [fi]: { year: y, month: m, day: d } }));
                    }}
                  />
                </div>

                <div className="review-document-preview">
                  {r.document.contentMarkdown.slice(0, 300)}
                  {r.document.contentMarkdown.length > 300 && '...'}
                </div>

                {!!r.document.metadata?.screeningType && isScreeningEligible(String(r.document.metadata.screeningType), userAge, sex) && (
                  <label className="review-screening-update">
                    <input
                      type="checkbox"
                      checked={screeningChecked[fi] ?? false}
                      onChange={(e) => setScreeningChecked(prev => ({ ...prev, [fi]: e.target.checked }))}
                    />
                    <span>
                      Update <strong>{String(r.document.metadata.screeningType)}</strong> screening date
                      {r.document.documentDate ? ` to ${r.document.documentDate}` : ''}
                    </span>
                  </label>
                )}
              </div>
            ) : (
              <p className="review-no-values">No blood test values or document found in this file</p>
            )}
          </div>
        );
      })}

      {!allDatesSet && (
        <p className="review-date-hint">Pick a day for every new column before saving — keeps the saved date precise.</p>
      )}

      {error && <p className="upload-error">{error}</p>}

      <div className="review-actions">
        <button
          className="btn-primary review-save-btn"
          onClick={handleSave}
          disabled={(selectedCount === 0 && selectedAdditionalCount === 0 && selectedDocCount === 0) || !allDatesSet || isSaving}
        >
          {isSaving ? 'Saving...' : `Save ${[
            selectedCount > 0 && `${selectedCount} Value${selectedCount !== 1 ? 's' : ''}`,
            selectedAdditionalCount > 0 && `${selectedAdditionalCount} Additional`,
            selectedDocCount > 0 && `${selectedDocCount} Document${selectedDocCount !== 1 ? 's' : ''}`,
          ].filter(Boolean).join(' + ')}`}
        </button>
        <button className="review-cancel-btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ============================================================================
// ReviewMatrix — the metric × date grid. Uses the same .bt-* CSS as the live
// BloodTestTimeline so visual treatment stays consistent. Existing-history
// cells render greyed-out; new (LLM-extracted) cells render an editable input.
// ============================================================================

interface ReviewMatrixProps {
  matrix: ReturnType<typeof buildMatrixModel>;
  unitSystem: UnitSystem;
  sex?: 'male' | 'female';
  editedDisplayValues: Record<string, string>;
  onCellChange: (cellKey: string, value: string) => void;
  onColumnDateChange: (col: MatrixColumn, update: Partial<FullDate>) => void;
}

function ReviewMatrix({
  matrix, unitSystem, sex, editedDisplayValues, onCellChange,
  onColumnDateChange,
}: ReviewMatrixProps) {
  const scrollSync = useMatrixScrollSync(matrix.columns.length);

  return (
    <div className="bt-timeline review-matrix">
      <div className="bt-timeline-body">
        <div className="bt-row bt-header-row">
          <div className="bt-cell-name bt-cell-header">METRIC</div>
          <div ref={scrollSync.registerHeader} onScroll={scrollSync.onScroll} className="bt-cell-strip">
            <div className="bt-strip-inner">
              {matrix.columns.map(col => (
                <MatrixColumnHeader key={col.dateKey} col={col} onDateChange={onColumnDateChange} />
              ))}
              <div className="bt-strip-spacer"/>
            </div>
          </div>
        </div>

        {matrix.coreRows.map((row, rowIdx) => (
          <MatrixRowView
            key={row.metric}
            row={row}
            rowIdx={rowIdx}
            columns={matrix.columns}
            cells={matrix.cells}
            unitSystem={unitSystem}
            sex={sex}
            scrollSync={scrollSync}
            editedDisplayValues={editedDisplayValues}
            onCellChange={onCellChange}
          />
        ))}

        {matrix.additionalRows.length > 0 && (
          <>
            <div className="bt-section-divider">Additional Lab Values</div>
            {matrix.additionalRows.map((row, i) => (
              <MatrixRowView
                key={row.nameKey}
                row={row}
                rowIdx={matrix.coreRows.length + i}
                columns={matrix.columns}
                cells={matrix.cells}
                unitSystem={unitSystem}
                sex={sex}
                scrollSync={scrollSync}
                editedDisplayValues={editedDisplayValues}
                onCellChange={onCellChange}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

/** Column header — shows the date. New (upload) columns render an editable
 *  date picker so the user can fix LLM-misread dates; existing-history
 *  columns are read-only (correction goes through the live timeline). */
function MatrixColumnHeader({ col, onDateChange }: { col: MatrixColumn; onDateChange: (col: MatrixColumn, update: Partial<FullDate>) => void }) {
  if (!col.isNew) {
    return (
      <div className="bt-cell-value bt-cell-context bt-cell-date">
        <span className="bt-value-num num">{formatColumnDate(col.date)}</span>
      </div>
    );
  }
  // New columns reuse DraftDateCell — same visual + native picker as the
  // live timeline's draft column. When the LLM didn't extract a day we
  // pass YYYY-MM-01 as a placeholder ISO and flag `needsDay` so the cell
  // renders "— Mon '24" instead of "1 Mon '24"; allDatesSet keeps save
  // disabled until the user picks a real day.
  const iso = `${col.date.year}-${col.date.month.padStart(2, '0')}-${(col.date.day ?? '01').padStart(2, '0')}`;
  return (
    <DraftDateCell
      date={iso}
      needsDay={!col.date.day}
      ariaLabel="Choose column date"
      onChange={picked => {
        const [y, m, d] = picked.split('-');
        if (y && m && d) onDateChange(col, { year: y, month: m, day: d });
      }}
    />
  );
}

function formatColumnDate(date: FullDate): string {
  const monthEntry = MONTHS_SHORT.find(m => m.value === date.month.padStart(2, '0'));
  const monthLabel = monthEntry?.label ?? date.month;
  const yy = date.year.slice(-2);
  return date.day ? `${date.day} ${monthLabel} '${yy}` : `${monthLabel} '${yy}`;
}

interface MatrixRowViewProps {
  row: MatrixRow;
  rowIdx: number;
  columns: MatrixColumn[];
  cells: Map<string, MatrixCell>;
  unitSystem: UnitSystem;
  sex?: 'male' | 'female';
  scrollSync: ReturnType<typeof useMatrixScrollSync>;
  editedDisplayValues: Record<string, string>;
  onCellChange: (cellKey: string, value: string) => void;
}

function MatrixRowView({
  row, rowIdx, columns, cells, unitSystem, sex, scrollSync,
  editedDisplayValues, onCellChange,
}: MatrixRowViewProps) {
  const rowKey = matrixRowKey(row);
  const { label, unitLabel, refLabel } = describeRow(row, unitSystem, sex);

  return (
    <div className="bt-row">
      <div className="bt-cell-name">
        <div className="bt-name-label">{label}</div>
        {unitLabel && <div className="bt-unit-chip">{unitLabel}</div>}
        {refLabel && <div className="bt-ref-label">{refLabel}</div>}
      </div>
      <div ref={el => scrollSync.registerRow(rowIdx, el)} onScroll={scrollSync.onScroll} className="bt-cell-strip">
        <div className="bt-strip-inner">
          {columns.map(col => {
            const cellKey = matrixCellKey(rowKey, col.dateKey);
            const cell = cells.get(cellKey) ?? { state: 'empty' as const };
            return (
              <MatrixCellView
                key={col.dateKey}
                cell={cell}
                cellKey={cellKey}
                row={row}
                unitSystem={unitSystem}
                sex={sex}
                editedValue={editedDisplayValues[cellKey] ?? ''}
                onCellChange={onCellChange}
              />
            );
          })}
          <div className="bt-strip-spacer"/>
        </div>
      </div>
    </div>
  );
}

/** Row label + unit chip + reference range. Core rows pull from UNIT_DEFS /
 *  METRIC_LABELS / getDisplayLabel; additional rows use the LLM-extracted
 *  unit and (if present) a reference range. */
function describeRow(row: MatrixRow, unitSystem: UnitSystem, sex?: 'male' | 'female'): { label: string; unitLabel: string | null; refLabel: string | null } {
  if (row.kind === 'core') {
    const label = METRIC_LABELS[row.metric] || row.metric;
    const unitLabel = UNIT_DEFS[row.metric] ? getDisplayLabel(row.metric, unitSystem) : null;
    // Same reference-range hint InputPanel + BloodTestTimeline show so
    // users have the same context when reviewing as when reading the
    // live timeline.
    const refLabel = refHintFor(row.metric, unitSystem, sex);
    return { label, unitLabel, refLabel };
  }
  const refLabel = (row.referenceLow != null || row.referenceHigh != null)
    ? `Ref: ${row.referenceLow ?? '–'}–${row.referenceHigh ?? '–'}`
    : null;
  return { label: row.displayName, unitLabel: row.unit, refLabel };
}

interface MatrixCellViewProps {
  cell: MatrixCell;
  cellKey: string;
  row: MatrixRow;
  unitSystem: UnitSystem;
  sex?: 'male' | 'female';
  editedValue: string;
  onCellChange: (cellKey: string, value: string) => void;
}

const MatrixCellView = memo(function MatrixCellView({
  cell, cellKey, row, unitSystem, sex, editedValue, onCellChange,
}: MatrixCellViewProps) {
  if (cell.state === 'empty') {
    return <div className="bt-cell-value bt-cell-empty"/>;
  }
  if (cell.state === 'context') {
    return (
      <div className="bt-cell-value bt-cell-context" title="Already saved at this date">
        <span className="bt-value-num num">{cell.displayValue}</span>
      </div>
    );
  }
  // Editable cell. For core metrics hand off to the shared NumericInputCell
  // so we get the same validation + status tick (ok/warn/bad) the live
  // timeline uses. Additional values have no clinical thresholds, so render
  // a plain input with no status preview.
  const handleChange = (v: string) => onCellChange(cellKey, v);
  const lowConfClass = cell.kind === 'core' && cell.confidence === 'low' ? ' bt-cell-low-confidence' : '';

  if (cell.kind === 'core') {
    return (
      <NumericInputCell
        metric={matrixRowKey(row) as MetricType}
        display={unitSystem}
        sex={sex}
        value={editedValue}
        onChange={handleChange}
        wrapperClass={`bt-cell-input bt-cell-review${lowConfClass}`}
      />
    );
  }
  return (
    <NumericInputCell
      value={editedValue}
      onChange={handleChange}
      wrapperClass="bt-cell-input bt-cell-review"
      showStatusPreview={false}
      ariaLabel={`${matrixRowKey(row)} value`}
    />
  );
});
