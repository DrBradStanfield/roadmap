import { useState, useMemo, useEffect, useCallback, useRef, type ReactNode } from 'react';
import { type UnitSystem, type MetricType, UNIT_DEFS } from '@roadmap/health-core/units';
import { healthInputSchema } from '@roadmap/health-core/validation';
import { METRIC_TO_FIELD } from '@roadmap/health-core/mappings';
import { commaQuestion } from '@roadmap/health-core/parseNumber';
import { sameLabQuantity } from '@roadmap/health-core/record-edits';
import { UNDATED_PREVIOUS } from '@roadmap/health-core/lab-extraction';
import type { UploadHistory } from '../lib/api-types';
import { type CellUnit, type Grading, cellNumber, cellText, cellToSI, hasNumericSyntax, NUMERIC_SYNTAX_GUIDANCE, readNumericCell, readTypedValue, validateTypedValue } from '../lib/blood-test-cell';
import { useLpaUnit } from '../lib/lpa-unit';
import { ReviewMatrix } from './ReviewMatrix';
import { ReviewFileSections } from './ReviewFileSections';
import { useReviewDocuments } from '../hooks/useReviewDocuments';
import { type FullDate, parseReportDate, longDate, columnDay, getDaysInMonth, buildRecordedAt, fullDateToIso } from '../lib/review-dates';
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
  const docs = useReviewDocuments(results, history, userAge, sex);
  const { selectedDocCount, archiveCount } = docs;
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

    const { reviewed, documents } = docs.documentsToSave(fileDates);

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

      <ReviewFileSections docs={docs} age={userAge} sex={sex} />

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
