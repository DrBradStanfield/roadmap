import { useState, useMemo, useEffect, useCallback, useRef, useId, type MutableRefObject, type ReactNode } from 'react';
import { FIX_ERRORS_TEXT } from '@roadmap/health-core/upload-text';
import { type UnitSystem, type MetricType, UNIT_DEFS } from '@roadmap/health-core/units';
import { healthInputSchema } from '@roadmap/health-core/validation';
import { METRIC_TO_FIELD } from '@roadmap/health-core/mappings';
import { commaQuestion } from '@roadmap/health-core/parseNumber';
import { sameLabQuantity } from '@roadmap/health-core/record-edits';
import { IMPORT_REVIEW_TEXT, importSummaryText } from '@roadmap/health-core/import-review';
import type { UploadReviewKey } from '@roadmap/health-core/product-events';
import { measurementRefusalLine } from '../lib/lab-value-labels';
import { classifyReview, currentEdits, refusedKeptIds, reviewEventMetadata, reviewRows, slotlessIds, type KeptValue } from '../lib/import-review-view';
import type { UploadHistory } from '../lib/api-types';
import { type CellUnit, type Grading, cellNumber, cellText, cellToSI, hasNumericSyntax, NUMERIC_SYNTAX_GUIDANCE, readNumericCell, readTypedValue, validateTypedValue } from '../lib/blood-test-cell';
import { useLpaUnit } from '../lib/lpa-unit';
import { ReviewMatrix } from './ReviewMatrix';
import { ReviewFileSections } from './ReviewFileSections';
import { NotSavedLine, SureLine, saveLabel, useDisclosure } from './ReviewOverview';
import { useReviewDocuments } from '../hooks/useReviewDocuments';
import { type FullDate, parseReportDate, longDate, columnDay, getDaysInMonth, buildRecordedAt, fullDateToIso } from '../lib/review-dates';
import type { FileResult, ReviewDecisions } from '../lib/upload-pipeline';
import { type DateKey, type MatrixColumn, type ExistingCell, type EditableMatrixCell, type CoreCellView, sameValue, editId, replaceKey, buildMatrixModel } from '../lib/review-matrix';

interface ReviewTableProps {
  results: FileResult[];
  history: UploadHistory;
  unitSystem: UnitSystem;
  metricUnitOverrides?: Partial<Record<MetricType, UnitSystem>>;
  onToggleFieldUnit?: (field: string) => void;
  /** The cards' screening age (US-06 AC5, US-23 AC6c), which sets screening eligibility. Unset with no plan or no valid birth year. */
  age?: number;
  /** With the age, sets screening eligibility. */
  sex?: 'male' | 'female';
  /** Whom the hints and status colours grade for; null for a known minor,
   *  as in the blood-test matrix (US-07 AC6). */
  grading: Grading;
  onSave: (decisions: ReviewDecisions) => void;
  onCancel: () => void;
  isSaving: boolean;
  error: string | null;
  /** The values the last save refused, shown beside its error (US-12 AC6). */
  refusals?: ReactNode;
  /** Set each render to the review's `upload_review` counts, for a review
   *  that Cancel ends (US-13 AC13). */
  countsRef?: MutableRefObject<(() => Partial<Record<UploadReviewKey, number>>) | null>;
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
  countsRef,
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
  // Each cell's text; an untouched cell reads its extraction until the effect below seeds it.
  const [editedDisplayValues, setEditedDisplayValues] = useState<Record<string, string>>({});
  // The matrix places, and the review's groups classify, the values as they now
  // stand: an edit's number, a cleared value's absence (US-13 AC13). Keyed by
  // content, so re-seeding untouched text never rebuilds the matrix.
  const editsNow = currentEdits(results, editedDisplayValues, touchedRef.current, units, unitSystem);
  // A value the person edited and has not cleared is pinned: it keeps its cell and its
  // slot whatever its number, judged on its own (owner, 2026-11-15).
  const pinnedNow = [...touchedRef.current.keys()].filter(id => (editedDisplayValues[id] ?? '').trim() !== '').sort();
  const editsKey = JSON.stringify([[...editsNow], pinnedNow]);
  const { edits, pinned } = useMemo(() => ({ edits: editsNow, pinned: new Set(pinnedNow) }), [results, editsKey]);
  // An unedited value the write refuses on its own takes no slot, as in the review's groups.
  const refusedNow = useMemo(() => slotlessIds(results, edits), [results, edits]);
  const slotless = useMemo(() => new Set([...refusedNow].filter(id => !pinned.has(id))), [refusedNow, pinned]);
  const matrix = useMemo(
    () => buildMatrixModel(results, fileDates, history.measurements, history.labValues, unitSystem, units, touchedRef.current, slotless, edits),
    [results, fileDates, history.measurements, history.labValues, unitSystem, units, touchedCount, slotless, edits],
  );
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
  const totalEditableCells = useMemo(() => {
    let n = 0;
    for (const cell of matrix.cells.values()) if (cell.state === 'editable') n++;
    return n;
  }, [matrix]);

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
  const needsDay = useMemo(() => {
    const writing = new Set(saveableCells.map(c => c.dateKey));
    return new Set(matrix.columns.filter(col => col.isNew && writing.has(col.dateKey) && !datedColumns.has(col.dateKey)).map(col => col.dateKey));
  }, [matrix.columns, saveableCells, datedColumns]);
  const allDatesSet = needsDay.size === 0;

  // The review's groups (US-13 AC13): one health-core call, a memo of the
  // results, their days and the record. Show all and the open "Not saved" are
  // view toggles; a hidden value keeps its cell text, so Save includes it.
  // Save submits what it returns (`decisions`): each kept cell, and each reading
  // the matrix hides behind a kept one, so a same-day loser is named under "Not saved".
  const groups = useMemo(() => {
    const day = new Map(matrix.columns.map(col => [col.dateKey, buildRecordedAt(col.date)]));
    const kept: KeptValue[] = saveableCells.map(c => ({ id: editId(c.cell), recordedAt: day.get(c.dateKey)!, correctsId: c.cell.existing?.id, ...(c.isEdited ? { edited: c.value } : null) }));
    const ids = new Set(kept.map(k => k.id));
    // A winner's refusal is judged on what Save would send for it, as Save reads its text.
    const refusedWinners = refusedKeptIds(results, kept);
    // A reading with no cell is sent, at its current number, while its winner is
    // kept and the write takes the winner: it never writes, and never stands in
    // for a pinned winner whose number the write refuses (Save is blocked then).
    const editable = new Set([...matrix.cells.values()].flatMap(c => (c.state === 'editable' ? [editId(c)] : [])));
    kept.push(...matrix.unshown.filter(u => edits.get(u.id) !== null
      && (!u.winner || (ids.has(u.winner) && !refusedWinners.has(u.winner)) || !editable.has(u.winner))).map(u => {
      const [fi, ref] = [Number(u.id.split(':')[0]), u.id.split(':')[1]];
      const extracted = ref[0] === 'v' ? results[fi].values[Number(ref.slice(1))].valueSI : results[fi].additionalValues[Number(ref.slice(1))].value;
      const edit = edits.get(u.id);
      return { id: u.id, recordedAt: `${u.day}T00:00:00.000Z`, ...(typeof edit === 'number' ? { edited: edit } : u.edited ? { edited: extracted } : null) };
    }));
    return classifyReview(results, fileDates, history, kept);
  }, [results, fileDates, history, matrix, saveableCells, edits]);
  // What Save writes, and the kept values waiting on a column's day (Save stays blocked until it is set).
  const savedCount = groups.decisions.values.length + groups.decisions.labValues.length
    + saveableCells.filter(c => groups.groupOf.get(editId(c.cell)) === 'waiting').length;
  const nothingSelected = savedCount === 0 && selectedDocCount === 0;
  // A kept value the write refuses (a blood pressure the wrong way up, a number
  // out of range) shows the write's own line and blocks Save, as a range error does (US-13 AC5).
  const cellViews = useMemo(() => {
    const views = new Map(coreCellViews);
    for (const [id, refusal] of groups.refusals) {
      const view = views.get(id);
      const metric = refusal.metricType as MetricType;
      if (view && !view.error) views.set(id, { ...view, error: measurementRefusalLine(refusal, units[metric] ?? unitSystem) });
    }
    return views;
  }, [coreCellViews, groups, units, unitSystem]);
  const refusedKept = [...groups.blocked].some(id => coreCellViews.has(id));
  const rows = useMemo(() => reviewRows(matrix, results, groups.groupOf, cellViews, needsDay, new Set(touchedRef.current.keys())), [matrix, results, groups, cellViews, needsDay, touchedCount]);
  const showAll = useDisclosure();
  const notSavedOpen = useDisclosure();
  const matrixId = useId();
  const shownMatrix = showAll.open ? matrix : rows.matrix;
  const hiddenSaving = [...rows.hidden].filter(id => groups.writes.has(id)).length;
  /** The `upload_review` counts (US-13 AC13). The upload flow sends them once
   *  per review: on a finished Save, or on Cancel; never for a failed Save or a hide. */
  const reviewCounts = (saved: boolean) => {
    const replaced = Object.keys(replaceChecked).filter(k => replaceChecked[k]).map(k => k.slice(0, k.indexOf('>')));
    return reviewEventMetadata(groups, [...touchedRef.current.keys(), ...replaced], { showAll: showAll.opened, notSaved: notSavedOpen.opened }, saved);
  };
  if (countsRef) countsRef.current = () => reviewCounts(false);

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
    if (hasInvalid || refusedKept || !allDatesSet) return;
    const { reviewed, documents } = docs.documentsToSave(fileDates);

    onSave({ ...groups.decisions, documents, reviewed, review: reviewCounts(true), labRefusals: groups.labRefusals });
  };

  // Nothing the review could save, by its groups: the review closes (D3).
  const nothingToSave = groups.count('sure') + groups.count('unsure') + groups.count('waiting') === 0
    && nothingSelected && archiveCount === 0 && results.every(r => !r.document);
  // "Check these" counts only the values to look at; a sure value sharing their row shows beside them.
  const checking = [...rows.shown].filter(id => groups.groupOf.get(id) !== 'sure').length;

  return (
    <div className="review-table">
      <p className="review-summary">{importSummaryText(groups.summary)}</p>
      {nothingSelected && archiveCount > 0 && (
        <p className="review-overview-line review-archive-only">Save will archive the original PDF{archiveCount !== 1 ? 's' : ''}. No extracted values or documents are selected.</p>
      )}

      {!showAll.open && checking > 0 && <h4 className="review-check-title">{IMPORT_REVIEW_TEXT.checkTitle(checking)}</h4>}
      <div id={matrixId}>
        {(shownMatrix.coreRows.length > 0 || shownMatrix.additionalRows.length > 0) && (
          <ReviewMatrix
            matrix={shownMatrix}
            unitSystem={unitSystem}
            metricUnitOverrides={units}
            onToggleFieldUnit={onToggleFieldUnit}
            onChooseLpaUnit={chooseLpaUnit}
            grading={grading}
            editedDisplayValues={editedDisplayValues}
            coreCellViews={cellViews}
            onCellChange={updateEditedDisplayValue}
            onColumnDateChange={handleColumnDateChange}
            datedColumns={datedColumns}
            pickHints={pickHints}
            replaceChecked={replaceChecked}
            heldEqual={heldEqual}
            onReplaceToggle={toggleReplace}
          />
        )}
      </div>
      {!showAll.open && checking > 0 && <p className="review-overview-footer">{IMPORT_REVIEW_TEXT.checkFooter}</p>}
      <SureLine hidden={rows.hidden.size} rows={rows.hiddenRows} saving={hiddenSaving} total={totalEditableCells} all={showAll} controls={matrixId} />
      {groups.held > 0 && <p className="review-overview-line">{IMPORT_REVIEW_TEXT.alreadySaved(groups.held)}</p>}
      <NotSavedLine notSaved={groups.notSaved} disclosure={notSavedOpen} />

      <ReviewFileSections docs={docs} age={userAge} sex={sex} />

      {!allDatesSet && (
        <p className="review-date-hint">Pick a past day for every new column before saving, and for previous results a day before the report's — keeps the saved date precise.</p>
      )}

      {(hasInvalid || refusedKept) && <p role="status">{FIX_ERRORS_TEXT}</p>}
      {/* One live region, so a screen reader hears the save's answer (US-12 AC6). */}
      <div className="review-save-outcome" role="status">
        {error && <p className="upload-error">{error}</p>}
        {refusals && <div className="review-refusals">{refusals}</div>}
      </div>

      <div className="review-actions">
        {!nothingToSave && <button
          className="btn-primary review-save-btn"
          onClick={handleSave}
          disabled={hasInvalid || refusedKept || (nothingSelected && archiveCount === 0) || !allDatesSet || isSaving}
        >
          {isSaving ? 'Saving...' : saveLabel(savedCount, selectedDocCount, archiveCount)}
        </button>}
        <button className="review-cancel-btn" onClick={onCancel} disabled={isSaving}>
          {nothingToSave ? 'Close' : 'Cancel'}
        </button>
      </div>
    </div>
  );
}
