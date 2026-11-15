import { useState, useMemo, useEffect, useCallback, useRef, useId, type MutableRefObject, type ReactNode } from 'react';
import { FIX_ERRORS_TEXT, UPLOAD_TEXT, UPLOAD_WINDOW_TEXT } from '@roadmap/health-core/upload-text';
import { type UnitSystem, type MetricType, UNIT_DEFS } from '@roadmap/health-core/units';
import { healthInputSchema } from '@roadmap/health-core/validation';
import { METRIC_TO_FIELD } from '@roadmap/health-core/mappings';
import { commaQuestion } from '@roadmap/health-core/parseNumber';
import { sameLabQuantity } from '@roadmap/health-core/record-edits';
import { IMPORT_REVIEW_TEXT } from '@roadmap/health-core/import-review';
import { UNDATED_PREVIOUS } from '@roadmap/health-core/lab-extraction';
import type { ChoiceChange, FileChoices } from '@roadmap/health-core/upload-choices';
import type { UploadReview } from '@roadmap/health-core/upload-review';
import type { UploadView } from '@roadmap/health-core/upload-view';
import type { UploadReviewKey } from '@roadmap/health-core/product-events';
import { measurementRefusalLine } from '../lib/lab-value-labels';
import { refAt, reviewEventMetadata, reviewGroups, reviewRows, slotlessIds } from '../lib/import-review-view';
import type { UploadHistory } from '../lib/api-types';
import { type CellUnit, type Grading, cellNumber, cellText, cellToSI, hasNumericSyntax, NUMERIC_SYNTAX_GUIDANCE, readNumericCell, readTypedValue, validateTypedValue } from '../lib/blood-test-cell';
import { useLpaUnit } from '../lib/lpa-unit';
import { ReviewMatrix } from './ReviewMatrix';
import { NotSavedLine, SureLine, useDisclosure } from './ReviewOverview';
import { type FullDate, parseReportDate, longDate, columnDay, getDaysInMonth, fullDateToIso, dateSource } from '../lib/review-dates';
import type { FileResult } from '../lib/upload-pipeline';
import { type MatrixColumn, type ExistingCell, type EditableMatrixCell, type CoreCellView, sameValue, editId, replaceKey, buildMatrixModel, matrixCellKey } from '../lib/review-matrix';

interface ReviewTableProps {
  /** The read lab reports, in the review's order (`review.labFiles`): a value's `editId` is `<index>:<ref>`. */
  results: FileResult[];
  /** Each one's choices, as the upload state holds them. */
  choices: readonly FileChoices[];
  review: UploadReview;
  view: UploadView;
  /** One choice for one file (the upload state's `chose`): every review decision lives there. */
  onChose: (fileId: string, change: ChoiceChange) => void;
  history: UploadHistory;
  unitSystem: UnitSystem;
  metricUnitOverrides?: Partial<Record<MetricType, UnitSystem>>;
  onToggleFieldUnit?: (field: string) => void;
  /** Whom the hints and status colours grade for; null for a known minor,
   *  as in the blood-test matrix (US-07 AC6). */
  grading: Grading;
  /** Save, with the review's `upload_review` counts (US-13 AC13). */
  onSave: (counts: Partial<Record<UploadReviewKey, number>>) => void;
  onCancel: () => void;
  isSaving: boolean;
  /** Set each render to the review's `upload_review` counts, for a review
   *  that Cancel ends (US-13 AC13). */
  countsRef?: MutableRefObject<(() => Partial<Record<UploadReviewKey, number>>) | null>;
  /** The review's other sections, after "Not saved": failed files, documents, the file list. */
  children?: ReactNode;
}

/**
 * A review date choice as the upload state keeps it (`testDay`, `previousDay`): a full day as
 * YYYY-MM-DD, and a pick still missing a part as `partial:<year>:<month>:<day>`, which no day rule
 * reads as a day, so Save waits for it (US-13 AC8, US-12 AC14).
 */
const PARTIAL = 'partial:';
function encodeDate(d: FullDate): string {
  return d.day && d.month && d.year ? fullDateToIso(d) : `${PARTIAL}${d.year}:${d.month}:${d.day ?? ''}`;
}
function decodeDate(s: string): FullDate {
  if (!s.startsWith(PARTIAL)) return parseReportDate(s);
  const [year, month, day] = s.slice(PARTIAL.length).split(':');
  return { year, month, day: day || null };
}

/** The same array while its items are the same: the matrix rebuilds only when a file's choices change. */
function useStable<T>(items: readonly T[]): readonly T[] {
  const kept = useRef(items);
  if (items.length !== kept.current.length || items.some((x, i) => x !== kept.current[i])) kept.current = items;
  return kept.current;
}

export function ReviewTable({
  results, choices: choicesNow, review, view, onChose,
  history, unitSystem, metricUnitOverrides, onToggleFieldUnit, grading,
  onSave, onCancel, isSaving, countsRef, children,
}: ReviewTableProps) {
  const choices = useStable(choicesNow);
  const fileIdOf = (fi: number) => review.labFiles[fi].fileId;
  // Lp(a) has its own three units, kept in the record, as in the blood-test
  // matrix (US-05 AC2); a two-way override for it drives nothing.
  const [lpaUnit, chooseLpaUnit] = useLpaUnit(unitSystem);
  const units = useMemo<Partial<Record<MetricType, CellUnit>>>(() => ({ ...metricUnitOverrides, lpa: lpaUnit }), [metricUnitOverrides, lpaUnit]);

  // Each column's date, from the state's choices: the test's day (else the report's), an undated
  // previous column's day, and a dated previous column's (`dateSource`, US-12 AC12, AC14).
  const fileDates = useMemo(() => {
    const dates: Record<string, FullDate> = {};
    results.forEach((r, fi) => {
      const c = choices[fi];
      dates[fi] = c.testDay !== null ? decodeDate(c.testDay) : parseReportDate(r.reportDate);
      if (c.previousDay !== null) dates[dateSource(fi, UNDATED_PREVIOUS)] = decodeDate(c.previousDay);
      for (const [printed, day] of Object.entries(c.columnDays ?? {})) dates[dateSource(fi, printed)] = parseReportDate(day);
    });
    return dates;
  }, [results, choices]);

  // Each value's number as the state holds it, by `editId`: an edit, or null when cleared (unticked).
  // The matrix places and the classification judges the same table (US-13 AC13).
  const edits = useMemo(() => {
    const out = new Map<string, number | null>();
    choices.forEach((c, fi) => {
      for (const [ref, v] of Object.entries(c.edits)) out.set(`${fi}:${ref}`, v);
      for (const [ref, on] of Object.entries(c.ticks)) if (!on) out.set(`${fi}:${ref}`, null);
    });
    return out;
  }, [choices]);
  // A value the person edited keeps its cell and its slot whatever its number, judged on its own (owner, 2026-11-15).
  const pinned = useMemo(() => new Set([...edits].flatMap(([id, v]) => (v === null ? [] : [id]))), [edits]);
  // An unedited value the write refuses on its own takes no slot, as in the review's groups.
  const refusedNow = useMemo(() => slotlessIds(results, edits), [results, edits]);
  const slotless = useMemo(() => new Set([...refusedNow].filter(id => !pinned.has(id))), [refusedNow, pinned]);
  const matrix = useMemo(
    () => buildMatrixModel(results, fileDates, history.measurements, history.labValues, unitSystem, units, pinned, slotless, edits),
    [results, fileDates, history.measurements, history.labValues, unitSystem, units, pinned, slotless, edits],
  );

  // The cells' text as typed: an input's own buffer, plain view state. A number it reads goes to the
  // state as an edit; text with an error stays here and blocks Save until corrected (US-13 AC5).
  // `touched`: the unit each value was typed in, so a unit toggle after typing never misconverts it.
  const touchedRef = useRef<Map<string, { display?: CellUnit }>>(new Map());
  const [editedDisplayValues, setEditedDisplayValues] = useState<Record<string, string>>({});
  const initialDisplayValues = useMemo<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    for (const cell of matrix.cells.values()) {
      if (cell.state === 'editable') map[editId(cell)] = cell.initialDisplay;
    }
    return map;
  }, [matrix]);
  // Reformat on unit-system switch + pick up newly-editable cells when a
  // date change reshapes the matrix. User-touched cells keep their text;
  // untouched cells get re-seeded from the (re-formatted) initial.
  useEffect(() => {
    setEditedDisplayValues(prev => {
      const next: Record<string, string> = {};
      const touched = touchedRef.current;
      for (const id of Object.keys(initialDisplayValues)) {
        next[id] = touched.has(id) && prev[id] !== undefined ? prev[id] : initialDisplayValues[id];
      }
      // A touched value that is not editable just now keeps its text for when the day moves on.
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

  /** A cell's text changed: kept as typed, and what it now says sent to the state as a choice. */
  const updateEditedDisplayValue = (id: string, value: string, display?: CellUnit) => {
    const existing = touchedRef.current.get(id);
    touchedRef.current.set(id, { display: display ?? existing?.display });
    setEditedDisplayValues(prev => ({ ...prev, [id]: value }));
    const { fi, ref } = refAt(id);
    const c = choices[fi];
    if (!c) return;
    const text = value.trim();
    // A cleared cell is not saved (clear-to-skip); typed again, it is.
    if (!text) return void (c.ticks[ref] !== false && onChose(fileIdOf(fi), { tick: ref, on: false }));
    if (c.ticks[ref] === false) onChose(fileIdOf(fi), { tick: ref, on: true });
    const cell = [...matrix.cells.values()].find((x): x is EditableMatrixCell => x.state === 'editable' && editId(x) === id);
    if (!cell || cellError(cell, text)) return;
    const number = isEditedText(cell, text) ? savedValue(cell, text) : undefined;
    if (number !== c.edits[ref]) onChose(fileIdOf(fi), { edit: ref, value: number ?? null });
  };

  // Conflict cells only: "Replace the saved value with this one", as the state holds it (US-13 AC7).
  const replaceChecked = useMemo(() => {
    const on: Record<string, boolean> = {};
    for (const cell of matrix.cells.values()) {
      if (cell.state !== 'editable' || !cell.existing) continue;
      const { fi, ref } = refAt(editId(cell));
      if (choices[fi]?.replace[ref] === cell.existing.id) on[replaceKey(cell, cell.existing)] = true;
    }
    return on;
  }, [matrix, choices]);
  const toggleReplace = useCallback((key: string, on: boolean) => {
    const cut = key.indexOf('>');
    const { fi, ref } = refAt(key.slice(0, cut));
    onChose(review.labFiles[fi].fileId, { replace: ref, correctsId: on ? key.slice(cut + 1) : null });
  }, [onChose, review]);

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
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the cells' text and the matrix are what change it
  }, [matrix, editedDisplayValues]);
  // A Replace box gone because the edit now equals the saved row loses its tick, so it never comes back ticked.
  useEffect(() => {
    for (const cell of matrix.cells.values()) {
      if (cell.state === 'editable' && cell.existing && heldEqual.has(editId(cell)) && replaceChecked[replaceKey(cell, cell.existing)]) toggleReplace(replaceKey(cell, cell.existing), false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- runs when the equal set changes
  }, [heldEqual]);

  // What each core cell shows, and the value its colour grades: the value it
  // saves (US-13 AC4), in the row's unit. Typed text is kept verbatim in the
  // unit it was typed in, so a unit toggle shows the same quantity in the new unit.
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
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the cells' text and the matrix are what change it
  }, [matrix, editedDisplayValues]);
  // A kept cell whose text has an error (not a number, out of range): Save waits for it (US-13 AC5).
  const hasInvalid = useMemo(() => [...matrix.cells.values()].some(cell => {
    if (cell.state !== 'editable' || (cell.existing && !replaceChecked[replaceKey(cell, cell.existing)])) return false;
    return !!coreCellViews.get(editId(cell))?.error && !!(editedDisplayValues[editId(cell)] ?? cell.initialDisplay).trim();
  }), [matrix, coreCellViews, replaceChecked, editedDisplayValues]);
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
   *  its printed month, before its file's report day when that is known (US-12 AC14). */
  const pickHints = useMemo(() => new Map(matrix.columns.flatMap(col => {
    if (!col.undated) return [];
    const report = columnDay(fileDates[col.undated.fi]);
    return [[col.dateKey, UPLOAD_WINDOW_TEXT.pickDay(col.undated.printedMonth ? longDate(col.undated.printedMonth) : null, report ? longDate(report) : null)] as const];
  })), [matrix.columns, fileDates]);

  /** New columns a kept value waits on for its day: kept in sight (US-13 AC8, US-12 AC14). */
  const needsDay = useMemo(() => new Set(matrix.columns.filter(col => col.isNew && !datedColumns.has(col.dateKey) && [...matrix.coreRows, ...matrix.additionalRows].some(row => {
    const cell = matrix.cells.get(matrixCellKey(row.kind === 'core' ? row.metric : row.nameKey, col.dateKey));
    return cell?.state === 'editable' && edits.get(editId(cell)) !== null;
  })).map(col => col.dateKey)), [matrix, datedColumns, edits]);

  // The review's groups (US-13 AC13): the upload's one classification, laid over the matrix.
  const groups = useMemo(() => reviewGroups(review), [review]);
  // A kept value the write refuses (a blood pressure the wrong way up, a number
  // out of range) shows the write's own line, as a range error does (US-13 AC5).
  const cellViews = useMemo(() => {
    const views = new Map(coreCellViews);
    for (const [id, refusal] of groups.refusals) {
      const cellView = views.get(id);
      const metric = refusal.metricType as MetricType;
      if (cellView && !cellView.error) views.set(id, { ...cellView, error: measurementRefusalLine(refusal, units[metric] ?? unitSystem) });
    }
    return views;
  }, [coreCellViews, groups, units, unitSystem]);
  const rows = useMemo(() => reviewRows(matrix, results, groups.groupOf, cellViews, needsDay, new Set(touchedRef.current.keys())), [matrix, results, groups, cellViews, needsDay, editedDisplayValues]);
  const showAll = useDisclosure();
  const notSavedOpen = useDisclosure();
  const matrixId = useId();
  const shownMatrix = showAll.open ? matrix : rows.matrix;
  const hiddenSaving = [...rows.hidden].filter(id => groups.writes.has(id)).length;
  /** The `upload_review` counts (US-13 AC13). The upload flow sends them once
   *  per review: on a finished Save, or on Cancel; never for a failed Save or a hide. */
  const reviewCounts = (saved: boolean) => {
    const replaced = Object.keys(replaceChecked).map(k => k.slice(0, k.indexOf('>')));
    return reviewEventMetadata(groups, [...touchedRef.current.keys(), ...replaced], { showAll: showAll.opened, notSaved: notSavedOpen.opened }, saved);
  };
  if (countsRef) countsRef.current = () => reviewCounts(false);

  /** Column-level date editing: every date source the column stands for takes the pick, as a
   *  choice on its file. New-column dates only — existing-history columns are read-only. */
  const handleColumnDateChange = (col: MatrixColumn, update: Partial<FullDate>) => {
    if (!col.isNew) return;
    // An undated column's day comes before its report's: a later pick (a stray "today") is refused, never written (US-12 AC14).
    const report = col.undated && columnDay(fileDates[col.undated.fi]);
    if (report && update.day && fullDateToIso({ ...col.date, ...update }) >= report) return;
    for (const source of col.sources) {
      const merged: FullDate = { ...(fileDates[source] ?? col.date), ...update, undated: undefined };
      if (merged.day && merged.month && merged.year) {
        const maxDay = getDaysInMonth(merged.month, merged.year);
        if (parseInt(merged.day) > maxDay) merged.day = String(maxDay);
      }
      const at = source.indexOf('@');
      const fi = Number(at < 0 ? source : source.slice(0, at));
      const printed = at < 0 ? null : source.slice(at + 1);
      if (printed === null) onChose(fileIdOf(fi), { testDay: encodeDate(merged) });
      else if (printed === UNDATED_PREVIOUS) onChose(fileIdOf(fi), { previousDay: encodeDate(merged) });
      else { const day = columnDay(merged); if (day) onChose(fileIdOf(fi), { columnDay: printed, day }); }
    }
  };

  const nothing = view.save.why === UPLOAD_TEXT.saveNothing;
  const why = hasInvalid ? FIX_ERRORS_TEXT : view.save.why;
  // "Check these" counts only the values to look at; a sure value sharing their row shows beside them.
  const checking = [...rows.shown].filter(id => groups.groupOf.get(id) !== 'sure').length;

  return (
    <div className="review-table">
      <p className="review-summary">{view.summary}</p>

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

      {children}

      {/* One live region, so a screen reader hears why Save waits, and the save's answer (US-12 AC6). */}
      <div className="review-save-outcome" role="status">
        {why && <p className="review-save-why">{why}</p>}
        {view.save.error && <p className="upload-error">{view.save.error}</p>}
      </div>

      <div className="review-actions">
        <button
          className="btn-primary review-save-btn"
          onClick={() => onSave(reviewCounts(true))}
          disabled={!view.save.enabled || hasInvalid || isSaving}
        >
          {isSaving ? UPLOAD_WINDOW_TEXT.saving : view.save.label}
        </button>
        <button className="review-cancel-btn" onClick={onCancel} disabled={isSaving}>
          {nothing ? UPLOAD_WINDOW_TEXT.close : UPLOAD_WINDOW_TEXT.cancel}
        </button>
      </div>
    </div>
  );
}
