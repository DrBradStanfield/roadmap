import { useState, useMemo, useEffect, useCallback, useRef, type ReactNode } from 'react';
import { type UnitSystem, type MetricType, UNIT_DEFS } from '@roadmap/health-core/units';
import { type DocumentType, healthInputSchema } from '@roadmap/health-core/validation';
import { METRIC_TO_FIELD } from '@roadmap/health-core/mappings';
import { commaQuestion } from '@roadmap/health-core/parseNumber';
import { isScreeningEligible } from '@roadmap/health-core/types';
import { sameLabQuantity } from '@roadmap/health-core/record-edits';
import { UNDATED_PREVIOUS } from '@roadmap/health-core/lab-extraction';
import type { ApiDocument, UploadHistory } from '../lib/api-types';
import { pendingRowsFor } from '@roadmap/health-core/document-save';
import { unarchivedOriginals } from '../lib/archive-payloads';
import { type CellUnit, type Grading, cellNumber, cellText, cellToSI, hasNumericSyntax, NUMERIC_SYNTAX_GUIDANCE, readNumericCell, readTypedValue, validateTypedValue } from '../lib/blood-test-cell';
import { useLpaUnit } from '../lib/lpa-unit';
import { DraftDateCell } from './DraftDateCell';
import { ReviewMatrix } from './ReviewMatrix';
import { type FullDate, parseReportDate, longDate, columnDay, pastDay, readDocumentDate, getDaysInMonth, buildRecordedAt, fullDateToIso } from '../lib/review-dates';
import type { FileResult, DocumentToSave, ReviewedValue, ReviewedLabValue } from '../lib/upload-pipeline';
import { type DateKey, type MatrixColumn, type ExistingCell, type EditableMatrixCell, type CoreCellView, sameValue, normaliseLabName, editId, replaceKey, buildMatrixModel } from '../lib/review-matrix';

interface ReviewTableProps {
  results: FileResult[];
  history: UploadHistory;
  unitSystem: UnitSystem;
  metricUnitOverrides?: Partial<Record<MetricType, UnitSystem>>;
  onToggleFieldUnit?: (field: string) => void;
  /** The plan's age, which sets screening eligibility (US-06 AC5). Unset with no plan or no valid birth year. */
  age?: number;
  /** With the age, sets screening eligibility. */
  sex?: 'male' | 'female';
  /** Whom the hints and status colours grade for; null for a known minor,
   *  as in the blood-test matrix (US-07 AC6). */
  grading: Grading;
  onSave: (payload: {
    values: ReviewedValue[];
    documents: DocumentToSave[];
    labValues: ReviewedLabValue[];
    /** Every result as reviewed: its report date (the column day, or null) and
     *  its document's title and date. The archive files originals from these,
     *  an unselected document included (US-13 AC6). */
    reviewed: FileResult[];
  }) => void;
  onCancel: () => void;
  isSaving: boolean;
  error: string | null;
  /** The values the last save refused, shown beside its error (US-12 AC6). */
  refusals?: ReactNode;
}

/** Dedup on sourceFileName: stable across LLM re-extractions (titles drift,
 *  the source filename doesn't). The user can manually re-check the box if
 *  they want to save a same-filename second copy. */
function buildDocHistoryIndex(history: ApiDocument[]): Set<string> {
  const idx = new Set<string>();
  for (const d of history) {
    if (!d.sourceFileName) continue;
    idx.add(d.sourceFileName);
  }
  return idx;
}

function isDocDuplicate(sourceFileName: string | null, idx: Set<string>): boolean {
  if (!sourceFileName) return false;
  return idx.has(sourceFileName);
}

/** The names under which `after` holds a document `before` did not: filed
 *  since (US-12 AC6). A reload that filed nothing names none (US-12 AC6b). */
function newlyFiledNames(before: ApiDocument[], after: ApiDocument[]): Set<string> {
  const held = new Set(before.map(d => d.id));
  return new Set(after.flatMap(d => (d.sourceFileName && !held.has(d.id) ? [d.sourceFileName] : [])));
}

/** `checked` with every document filed under one of `filed` unticked. */
function uncheckFiled(checked: Record<number, boolean>, results: FileResult[], filed: Set<string>): Record<number, boolean> {
  const next = { ...checked };
  results.forEach((r, fi) => { if (r.document && filed.has(r.fileName)) next[fi] = false; });
  return next;
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
  metricUnitOverrides,
  onToggleFieldUnit,
  age: userAge,
  sex,
  grading,
  onSave,
  onCancel,
  isSaving,
  error,
  refusals,
}: ReviewTableProps) {
  const docHistoryIndex = useMemo(() => buildDocHistoryIndex(history.documents), [history.documents]);
  // Lp(a) has its own three units, kept in the record, as in the blood-test
  // matrix (US-05 AC2); a two-way override for it drives nothing.
  const [lpaUnit, chooseLpaUnit] = useLpaUnit(unitSystem);
  const units = useMemo<Partial<Record<MetricType, CellUnit>>>(() => ({ ...metricUnitOverrides, lpa: lpaUnit }), [metricUnitOverrides, lpaUnit]);

  // Full date state (day/month/year) per file, and, once edited, per printed
  // day of a dated previous-results column (`dateSource`, US-12 AC12).
  const [fileDates, setFileDates] = useState<Record<string, FullDate>>(() => {
    const dates: Record<string, FullDate> = {};
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

  // Default: checked for new docs, unchecked for already-saved ones.
  const [docChecked, setDocChecked] = useState<Record<number, boolean>>(() => {
    const map: Record<number, boolean> = {};
    results.forEach((r, fi) => {
      if (!r.document) return;
      map[fi] = !isDocDuplicate(r.fileName, docHistoryIndex);
    });
    return map;
  });
  // A document the record now holds (a partial save reloaded history) unchecks
  // itself, so a retry cannot file it twice. The user can still re-tick it,
  // and a reload that filed nothing under its name keeps that tick (US-12 AC6b).
  const shownDocuments = useRef(history.documents);
  useEffect(() => {
    const filed = newlyFiledNames(shownDocuments.current, history.documents);
    shownDocuments.current = history.documents;
    setDocChecked(prev => uncheckFiled(prev, results, filed));
  }, [history.documents, results]);

  // A document whose bytes metadata-only shown-document rows hold (a failed
  // upload, or the connector's) replaces them, so its card starts from the
  // newest: the user sees the earlier title and date, a missing date included,
  // and can change them (US-14 AC4).
  const [heldRows] = useState(() => results.map(r => (r.document ? pendingRowsFor(history.documents, r.contentHash, false)[0] : undefined)));
  // A document's date is its own, never the blood-test column's: the day it
  // saves, null until known or picked. A month alone still dates its
  // screening update until the user picks a day or clears it (US-13 AC6).
  const [documentDates, setDocumentDates] = useState<Record<number, { day: string | null; month: string | null }>>(() =>
    Object.fromEntries(results.map((r, fi) => [fi, readDocumentDate(heldRows[fi] ? heldRows[fi].documentDate : r.document?.documentDate)])));
  const screeningDateFor = (fi: number) => documentDates[fi]?.day ?? documentDates[fi]?.month ?? null;

  // Per-document: editable title
  const [docTitles, setDocTitles] = useState<Record<number, string>>(() => {
    const map: Record<number, string> = {};
    results.forEach((r, fi) => { if (r.document) map[fi] = heldRows[fi]?.title ?? r.document.title; });
    return map;
  });

  // Per-document: whether to update screening date (when screeningType is present AND user is old enough).
  // No age (no plan) starts unticked: eligibility is unknown (US-06 AC5). The user can still tick it.
  const [screeningChecked, setScreeningChecked] = useState<Record<number, boolean>>(() => {
    const map: Record<number, boolean> = {};
    results.forEach((r, fi) => {
      const st = r.document?.metadata?.screeningType as string | undefined;
      if (st && userAge !== undefined && isScreeningEligible(st, userAge, sex)) {
        map[fi] = true;
      }
    });
    return map;
  });

  // The matrix model is the source of truth for what's rendered + what's
  // saveable. Cells in `context` state come from history (greyed, no edit);
  // `editable` cells come from this upload. Save selection = an editable
  // cell whose `editedDisplayValues` entry is non-empty (clear-to-skip).
  // Per-cell edit metadata. Membership = "user touched this cell" (drives
  // the touched-stays-on-toggle behaviour below). `display` is the row's
  // display unit at the moment of edit, read at save time so a unit toggle
  // *after* typing doesn't misconvert the typed value into the wrong SI.
  const touchedRef = useRef<Map<string, { display?: CellUnit }>>(new Map());
  // How many values are touched: rebuilds the matrix when a value is first
  // edited, so a slot's winner and loser are judged as edited (`place`).
  const [touchedCount, setTouchedCount] = useState(0);
  const matrix = useMemo(
    () => buildMatrixModel(results, fileDates, history.measurements, history.labValues, unitSystem, units, touchedRef.current),
    [results, fileDates, history.measurements, history.labValues, unitSystem, units, touchedCount],
  );
  /** One line naming the hidden readings by test and day, never a value (US-12 AC14). */
  const hiddenNotice = useMemo(() => {
    const n = matrix.hiddenReadings.length;
    if (n === 0) return null;
    // Grouped by where: a day, or every unpicked undated column as one group.
    const undated = new Set(matrix.hiddenReadings.map(r => r.day).filter(day => !longDate(day)));
    const byPlace = new Map<string, Set<string>>();
    for (const { label, day } of matrix.hiddenReadings) {
      const date = longDate(day);
      const place = date ? `on ${date}` : `in the undated previous column${undated.size > 1 ? 's' : ''}`;
      byPlace.set(place, (byPlace.get(place) ?? new Set()).add(label));
    }
    const names = [...byPlace.values()].reduce((count, labels) => count + labels.size, 0);
    const groups = [...byPlace].map(([place, labels]) => `${[...labels].join(', ')} ${place}`).join('; ');
    return `${n} reading${n === 1 ? '' : 's'} not saved: ${groups} already ${names === 1 ? 'has' : 'have'} another reading.`;
  }, [matrix]);

  // Initial display values are derived from the matrix (not from raw results)
  // so the unit-system switch re-formats them and dedup-collapsed cells
  // (LLM value silently dropped where history wins) don't appear here.
  const initialDisplayValues = useMemo<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    for (const cell of matrix.cells.values()) {
      if (cell.state === 'editable') map[editId(cell)] = cell.initialDisplay;
    }
    return map;
  }, [matrix]);

  const [editedDisplayValues, setEditedDisplayValues] = useState<Record<string, string>>(
    () => ({ ...initialDisplayValues }),
  );
  // Conflict cells only: "Replace the saved value with this one". Default
  // off — the record already holds a value, so replacing is the user's call.
  const [replaceChecked, setReplaceChecked] = useState<Record<string, boolean>>({});
  const toggleReplace = useCallback((key: string, on: boolean) => {
    setReplaceChecked(prev => ({ ...prev, [key]: on }));
  }, []);

  const updateEditedDisplayValue = useCallback((id: string, value: string, display?: CellUnit) => {
    const existing = touchedRef.current.get(id);
    if (!existing) setTouchedCount(n => n + 1);
    touchedRef.current.set(id, { display: display ?? existing?.display });
    setEditedDisplayValues(prev => ({ ...prev, [id]: value }));
  }, []);

  // Reformat on unit-system switch + pick up newly-editable cells when a
  // date change reshapes the matrix. User-touched cells keep their text;
  // untouched cells get re-seeded from the (re-formatted) initial; untouched
  // cells that vanished from the model drop out.
  useEffect(() => {
    setEditedDisplayValues(prev => {
      const next: Record<string, string> = {};
      const touched = touchedRef.current;
      for (const id of Object.keys(initialDisplayValues)) {
        next[id] = touched.has(id) && prev[id] !== undefined ? prev[id] : initialDisplayValues[id];
      }
      // A touched value that is not editable just now (its day holds it as
      // saved, or a primary reading took the slot) keeps its text for when
      // the day moves on: an edit is never dropped by a date pick.
      for (const id of touched.keys()) if (!(id in next) && prev[id] !== undefined) next[id] = prev[id];
      return next;
    });
  }, [initialDisplayValues]);

  const metricOf = (cell: EditableMatrixCell) =>
    cell.kind === 'core' ? results[cell.fi]?.values[cell.vi]?.metric as MetricType | undefined : undefined;
  const extractedError = (cell: EditableMatrixCell): string | null => {
    const metric = metricOf(cell);
    if (!metric || !UNIT_DEFS[metric]) return null;
    const parsed = healthInputSchema.shape[METRIC_TO_FIELD[metric] as keyof typeof healthInputSchema.shape].safeParse(cell.valueSI);
    return parsed.success ? null : parsed.error.issues[0].message;
  };
  // Equal rendered text preserves valid extraction precision. An explicit
  // correction of an invalid extraction must instead use the typed quantity.
  const isEditedText = (cell: EditableMatrixCell, editedStr: string) => {
    const typedIn = touchedRef.current.get(editId(cell))?.display;
    const metric = metricOf(cell);
    return (touchedRef.current.has(editId(cell)) && extractedError(cell) !== null)
      || editedStr !== (typedIn && metric && UNIT_DEFS[metric] ? cellNumber(metric, cell.valueSI, typedIn, cell.comparator) : cell.initialDisplay);
  };

  /** The value a cell saves (SI for a core metric): the extracted one while
   *  untouched, which re-deriving from its rounded display would move (Lp(a)
   *  124.9 nmol/L shows "50.0" mg/dL → 125); once edited, the typed number in the
   *  unit it was typed in, so a toggle after typing never misconverts it. */
  const savedValue = (cell: EditableMatrixCell, editedStr: string): number | undefined => {
    if (!isEditedText(cell, editedStr)) return cell.valueSI;
    const metric = metricOf(cell);
    const typedIn = metric && UNIT_DEFS[metric] ? touchedRef.current.get(editId(cell))?.display ?? units[metric] ?? unitSystem : undefined;
    const parsed = metric && typedIn ? readTypedValue(metric, editedStr, typedIn) : readNumericCell(editedStr);
    if (parsed === undefined) return undefined;
    return metric && typedIn ? cellToSI(metric, parsed, typedIn) : parsed;
  };

  // Validate the quantity we save, not a rounded rendering after a unit switch.
  // Untouched extraction is canonical; edited text uses the same reader as Save.
  const cellError = (cell: EditableMatrixCell, text: string): string | null => {
    const metric = metricOf(cell);
    if (!text) return null;
    if (isEditedText(cell, text) && !hasNumericSyntax(text)) return NUMERIC_SYNTAX_GUIDANCE;
    if (!metric || !UNIT_DEFS[metric]) return !isEditedText(cell, text) ? null
      : commaQuestion(text) ?? (readNumericCell(text) === undefined ? 'Enter a number' : null);
    if (isEditedText(cell, text)) {
      return validateTypedValue(metric, text, touchedRef.current.get(editId(cell))?.display ?? units[metric] ?? unitSystem).error;
    }
    return extractedError(cell);
  };

  /** Is a ticked replacement the value already saved? A lab compares quantity, in its printed unit (US-35 AC6).
   *  A limit and an exact value of one number differ; an edited cell is exact (US-12 AC20). */
  const replacesNothing = (cell: EditableMatrixCell, existing: ExistingCell, value: number, editedStr: string): boolean => {
    const offered = isEditedText(cell, editedStr) ? undefined : cell.comparator;
    return existing.valueSI !== undefined ? sameValue(value, existing.valueSI) && existing.comparator === offered
      : existing.lab && cell.kind === 'additional' ? sameLabQuantity(existing.lab, { ...cell.lab, value, comparator: offered })
        : editedStr === existing.display;
  };

  /** Walks the matrix cells, returns the editable ones with a non-empty
   *  edited display value — the cells that will save. Shared by both the
   *  summary counts and handleSave so they stay in sync. */

  const collectSaveableCells = () => {
    interface CellPayload {
      dateKey: DateKey;
      cell: EditableMatrixCell;
      value: number;
      isEdited: boolean;
    }
    const out: CellPayload[] = [];
    let hasInvalid = false;
    for (const [cellKey, cell] of matrix.cells) {
      if (cell.state !== 'editable') continue;
      // A conflicting cell saves only when the user asserts the replacement.
      if (cell.existing && !replaceChecked[replaceKey(cell, cell.existing)]) continue;
      const editedStr = (editedDisplayValues[editId(cell)] ?? cell.initialDisplay).trim();
      if (!editedStr) continue;
      if (cellError(cell, editedStr)) {
        hasInvalid = true;
        continue;
      }
      const value = savedValue(cell, editedStr);
      if (value === undefined) continue;
      // A "replacement" that matches what is already saved would append a
      // correction row that corrects nothing. The slot is already right.
      if (cell.existing && replacesNothing(cell, cell.existing, value, editedStr)) continue;
      // dateKey is the suffix after the LAST `|` — robust against the
      // (rare) chance the rowKey itself contains a separator.
      const dateKey = cellKey.slice(cellKey.lastIndexOf('|') + 1);
      out.push({ dateKey, cell, value, isEdited: isEditedText(cell, editedStr) });
    }
    return { cells: out, hasInvalid };
  };

  const { cells: saveableCells, hasInvalid } = useMemo(collectSaveableCells, [matrix, editedDisplayValues, replaceChecked]);
  /** Cells whose value as now typed is the saved row's: already saved, so no
   *  Replace is offered and nothing saves (an edit judged by its edited value). */
  const heldEqual = useMemo(() => {
    const ids = new Set<string>();
    for (const cell of matrix.cells.values()) {
      if (cell.state !== 'editable' || !cell.existing) continue;
      const text = (editedDisplayValues[editId(cell)] ?? cell.initialDisplay).trim();
      const value = savedValue(cell, text);
      if (value !== undefined && replacesNothing(cell, cell.existing, value, text)) ids.add(editId(cell));
    }
    return ids;
  }, [matrix, editedDisplayValues]);
  // A Replace box gone because the edit now equals the saved row loses its
  // tick, so it never comes back ticked.
  useEffect(() => {
    const gone = [...matrix.cells.values()].flatMap(c => (c.state === 'editable' && c.existing && heldEqual.has(editId(c)) ? [replaceKey(c, c.existing)] : []));
    if (gone.some(k => replaceChecked[k])) setReplaceChecked(prev => Object.fromEntries(Object.entries(prev).filter(([k]) => !gone.includes(k))));
  }, [heldEqual]);
  // What each core cell shows, and the value its colour grades: the value it
  // saves (US-13 AC4), in the row's unit. Typed text is kept verbatim in the
  // unit it was typed in, so a unit toggle shows the same quantity in the new
  // unit and edits nothing (as a typed weight is kept, US-05).
  const coreCellViews = useMemo(() => {
    const views = new Map<string, CoreCellView>();
    for (const cell of matrix.cells.values()) {
      if (cell.state !== 'editable') continue;
      const metric = metricOf(cell);
      const text = (editedDisplayValues[editId(cell)] ?? cell.initialDisplay).trim();
      const limit = cell.comparator && !isEditedText(cell, text) ? { comparator: cell.comparator } : {};
      if (!metric) {
        views.set(editId(cell), { valueSI: savedValue(cell, text), error: cellError(cell, text), text, ...limit });
        continue;
      }
      const valueSI = savedValue(cell, text);
      const shownIn = units[metric] ?? unitSystem;
      const typedIn = touchedRef.current.get(editId(cell))?.display ?? shownIn;
      views.set(editId(cell), {
        ...limit,
        valueSI,
        error: cellError(cell, text),
        text: !isEditedText(cell, text) ? cell.initialDisplay
          : typedIn === shownIn || valueSI === undefined || !UNIT_DEFS[metric] ? text
          : cellText(metric, valueSI, shownIn),
      });
    }
    return views;
  }, [matrix, editedDisplayValues]);
  const selectedCount = useMemo(() => saveableCells.filter(c => c.cell.kind === 'core').length, [saveableCells]);
  const selectedAdditionalCount = useMemo(() => saveableCells.filter(c => c.cell.kind === 'additional').length, [saveableCells]);
  const totalEditableCells = useMemo(() => {
    let n = 0;
    for (const cell of matrix.cells.values()) if (cell.state === 'editable') n++;
    return n;
  }, [matrix]);
  const selectedDocCount = useMemo(() => Object.values(docChecked).filter(Boolean).length, [docChecked]);
  // Original lab PDFs remain retryable after saved values become context.
  // Connector metadata-only letters also carry archive-only work (US-35 AC8).
  const archiveCount = useMemo(() => {
    const selectedDocs = new Set(results.filter((r, fi) => r.document && docChecked[fi]).map((r) => r.fileName));
    return unarchivedOriginals(results, history.documents, selectedDocs).length;
  }, [results, history.documents, docChecked]);
  const nothingSelected = selectedCount === 0 && selectedAdditionalCount === 0 && selectedDocCount === 0;

  /** The new columns Save may write on: a calendar day that has happened
   *  (US-13 AC8), and for an undated previous column one before its report's
   *  own day when that is known, so a stray "today" never dates it (US-12 AC14). */
  const datedColumns = useMemo(() => new Set(matrix.columns.filter(col => {
    const day = columnDay(col.date);
    const report = col.undated && columnDay(fileDates[col.undated.fi]);
    return day && (!report || day < report);
  }).map(col => col.dateKey)), [matrix.columns, fileDates]);

  /** What an undated column's header asks for while it has no day: a day in
   *  its printed month, before its file's report day when that is known, even
   *  when the file shows no report column (US-12 AC14). */
  const pickHints = useMemo(() => new Map(matrix.columns.flatMap(col => {
    if (!col.undated) return [];
    const { printedMonth: month } = col.undated;
    const report = columnDay(fileDates[col.undated.fi]);
    const inMonth = month ? ` in ${longDate(month)}` : '';
    const before = report ? ` before ${longDate(report)}` : '';
    return [[col.dateKey, `Pick a day${inMonth}${before}`] as const];
  })), [matrix.columns, fileDates]);

  /** A column with no date isn't saveable. Existing-history columns always
   *  have a YYYY-MM-DD date; a new (upload) column that will write a cell
   *  needs to be in `datedColumns`, so dedup against history matches exactly (a month-only
   *  upload would silently synthesise day=01) and no misread or future date
   *  is ever written: rows are append-only (US-13 AC8). A column whose cells
   *  are all cleared writes nothing and needs no date. */
  const allDatesSet = useMemo(() => {
    const writing = new Set(saveableCells.map(c => c.dateKey));
    return matrix.columns.every(col => !col.isNew || !writing.has(col.dateKey) || datedColumns.has(col.dateKey));
  }, [matrix.columns, saveableCells, datedColumns]);

  /** Column-level date editing: propagate to every contributing date source so
   *  the matrix stays consistent. New-column dates only — existing-history
   *  columns are read-only (correction goes through the live timeline). */
  const handleColumnDateChange = (col: MatrixColumn, update: Partial<FullDate>) => {
    if (!col.isNew) return;
    setFileDates(prev => {
      // An undated column's day comes before its report's: a later pick (a
      // stray "today") is refused, never written (US-12 AC14).
      const report = col.undated && columnDay(prev[col.undated.fi]);
      if (report && update.day && fullDateToIso({ ...col.date, ...update }) >= report) return prev;
      const next = { ...prev };
      for (const source of col.sources) {
        const merged: FullDate = { ...(prev[source] ?? col.date), ...update, undated: undefined };
        if (merged.day) {
          const maxDay = getDaysInMonth(merged.month, merged.year);
          if (parseInt(merged.day) > maxDay) merged.day = String(maxDay);
        }
        next[source] = merged;
      }
      return next;
    });
  };

  const handleSave = () => {
    if (hasInvalid || !allDatesSet) return;
    // Collect core lab values
    const selected: ReviewedValue[] = [];
    const selectedLabValues: ReviewedLabValue[] = [];

    // O(1) column lookup so save doesn't go quadratic on big uploads.
    const columnsByKey = new Map(matrix.columns.map(col => [col.dateKey, col]));
    // One row per (test, day). buildMatrixModel already shows one reading per
    // slot, in this same rank (US-12 AC12, AC14); this is the backstop.
    const rank = (cell: EditableMatrixCell) => {
      const day = (cell.kind === 'core' ? results[cell.fi]?.values[cell.vi] : results[cell.fi]?.additionalValues[cell.ai])?.recordedAt;
      return !day ? 0 : day === UNDATED_PREVIOUS ? 2 : 1;
    };
    const slots = new Set<string>();

    for (const c of [...saveableCells].sort((a, b) => rank(a.cell) - rank(b.cell))) {
      const col = columnsByKey.get(c.dateKey);
      if (!col) continue;
      const recordedAt = buildRecordedAt(col.date);
      const cell = c.cell;
      const slot = `${cell.kind === 'core' ? metricOf(cell) : normaliseLabName(results[cell.fi]?.additionalValues[cell.ai]?.name ?? '')}|${recordedAt}`;
      if (slots.has(slot)) continue;
      slots.add(slot);
      if (cell.kind === 'core') {
        const metric = metricOf(cell);
        if (!metric) continue;
        selected.push({
          metric,
          valueSI: c.value,
          recordedAt,
          source: c.isEdited ? 'lab_import_edited' : undefined,
          correctsId: cell.existing?.id,
          // A limit saves as printed; a number typed over it is exact (US-12 AC20).
          ...(cell.comparator && !c.isEdited ? { comparator: cell.comparator } : {}),
        });
      } else {
        const av = results[cell.fi]?.additionalValues[cell.ai];
        if (!av) continue;
        selectedLabValues.push({
          name: av.name,
          value: c.value,
          unit: av.unit,
          referenceLow: av.referenceLow,
          referenceHigh: av.referenceHigh,
          recordedAt,
          correctsId: cell.existing?.id,
          ...(cell.comparator && !c.isEdited ? { comparator: cell.comparator } : {}),
        });
      }
    }

    // Every result as reviewed. The report date is the column's past day or
    // unknown, never the extracted string (US-13 AC8).
    const reviewed: FileResult[] = results.map((r, fi) => ({
      ...r,
      reportDate: columnDay(fileDates[fi]),
      ...(r.document ? { document: { ...r.document, title: docTitles[fi] || r.document.title, documentDate: documentDates[fi]?.day ?? null } } : {}),
    }));
    const documents: DocumentToSave[] = [];
    reviewed.forEach(({ document: doc, fileName, file }, fi) => {
      if (!doc || !docChecked[fi]) return;
      const screeningType = doc.metadata?.screeningType as string | undefined;
      const screeningDate = screeningDateFor(fi);
      documents.push({
        documentType: doc.classification,
        title: doc.title,
        documentDate: doc.documentDate,
        contentMd: doc.contentMarkdown,
        metadata: doc.metadata,
        sourceFileName: fileName,
        screeningUpdate: screeningType && screeningChecked[fi] && screeningDate
          ? { key: `${screeningType}_last_date`, date: screeningDate }
          : undefined,
        file,
      });
    });

    onSave({ values: selected, documents, labValues: selectedLabValues, reviewed });
  };

  return (
    <div className="review-table">
      <div className="review-summary">
        {nothingSelected && archiveCount > 0 ? (
          `Save will archive the original PDF${archiveCount !== 1 ? 's' : ''}. No extracted values or documents are selected.`
        ) : (
          <>
            {selectedCount > 0 && `${selectedCount} value${selectedCount !== 1 ? 's' : ''}`}
            {selectedCount > 0 && selectedAdditionalCount > 0 && ' + '}
            {selectedAdditionalCount > 0 && `${selectedAdditionalCount} additional`}
            {(selectedCount > 0 || selectedAdditionalCount > 0) && selectedDocCount > 0 && ' + '}
            {selectedDocCount > 0 && `${selectedDocCount} document${selectedDocCount !== 1 ? 's' : ''}`}
            {nothingSelected && 'No items selected'}
            {' '}from {results.length} file{results.length !== 1 ? 's' : ''} · {totalEditableCells} extracted
          </>
        )}
      </div>

      {(matrix.coreRows.length > 0 || matrix.additionalRows.length > 0) && (
        <ReviewMatrix
          matrix={matrix}
          unitSystem={unitSystem}
          metricUnitOverrides={units}
          onToggleFieldUnit={onToggleFieldUnit}
          onChooseLpaUnit={chooseLpaUnit}
          grading={grading}
          editedDisplayValues={editedDisplayValues}
          coreCellViews={coreCellViews}
          onCellChange={updateEditedDisplayValue}
          onColumnDateChange={handleColumnDateChange}
          datedColumns={datedColumns}
          pickHints={pickHints}
          replaceChecked={replaceChecked}
          heldEqual={heldEqual}
          onReplaceToggle={toggleReplace}
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

        const documentDate = documentDates[fi]?.day ?? null;
        const month = documentDates[fi]?.month;
        const screeningDate = screeningDateFor(fi);
        const isDocDup = r.document ? isDocDuplicate(r.fileName, docHistoryIndex) : false;

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
                  {/* No day: an empty picker, "— Jun '24" for a month alone
                      or "Date unknown", so any day picked sets it (US-13 AC6). */}
                  <DraftDateCell
                    date={documentDate ?? (month ? `${month}-01` : fullDateToIso(fileDates[fi]))}
                    needsDay={!documentDate}
                    placeholder={documentDate || month ? undefined : 'Date unknown'}
                    ariaLabel="Document date"
                    onChange={picked => {
                      // Cleared is unknown, its month too; a day not yet happened is refused, never written.
                      const day = pastDay(picked);
                      if (!picked || day) setDocumentDates(prev => ({ ...prev, [fi]: { day, month: null } }));
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
                      checked={!!screeningDate && (screeningChecked[fi] ?? false)}
                      disabled={!screeningDate}
                      onChange={(e) => setScreeningChecked(prev => ({ ...prev, [fi]: e.target.checked }))}
                    />
                    <span>
                      Update <strong>{String(r.document.metadata.screeningType)}</strong> screening date
                      {screeningDate ? ` to ${screeningDate}` : ' (pick the document date first)'}
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
        <p className="review-date-hint">Pick a past day for every new column before saving, and for previous results a day before the report's — keeps the saved date precise.</p>
      )}

      {hiddenNotice && <p className="review-date-hint" role="status">{hiddenNotice}</p>}

      {hasInvalid && <p role="status">Correct or clear the values with errors before saving.</p>}
      {/* One live region, so a screen reader hears the save's answer (US-12 AC6). */}
      <div className="review-save-outcome" role="status">
        {error && <p className="upload-error">{error}</p>}
        {refusals && <div className="review-refusals">{refusals}</div>}
      </div>

      <div className="review-actions">
        <button
          className="btn-primary review-save-btn"
          onClick={handleSave}
          disabled={hasInvalid || (nothingSelected && archiveCount === 0) || !allDatesSet || isSaving}
        >
          {isSaving ? 'Saving...' : `Save ${[
            selectedCount > 0 && `${selectedCount} Value${selectedCount !== 1 ? 's' : ''}`,
            selectedAdditionalCount > 0 && `${selectedAdditionalCount} Additional`,
            selectedDocCount > 0 && `${selectedDocCount} Document${selectedDocCount !== 1 ? 's' : ''}`,
            archiveCount > 0 && `${archiveCount} Original${archiveCount !== 1 ? 's' : ''}`,
          ].filter(Boolean).join(' + ')}`}
        </button>
        <button className="review-cancel-btn" onClick={onCancel} disabled={isSaving}>
          Cancel
        </button>
      </div>
    </div>
  );
}
