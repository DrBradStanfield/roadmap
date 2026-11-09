import { memo, useId } from 'react';
import { type LpaUnit, type UnitSystem, type MetricType, UNIT_DEFS, hasUnitChoice } from '@roadmap/health-core/units';
import { METRIC_LABELS, METRIC_TO_FIELD } from '@roadmap/health-core/mappings';
import { resolveLabCatalogEntry, canonicalLabRow, labCountFault, labPlausibleBound } from '@roadmap/health-core/lab-catalog';
import { withComparator, type Comparator } from '@roadmap/health-core/lab-limits';
import { labUnitRefusalLine } from '@roadmap/health-core/lab-series';
import { rowTarget } from '@roadmap/health-core/row-target';
import { useMatrixScrollSync } from '../lib/useMatrixScrollSync';
import { type CellUnit, type Grading, cellLabel } from '../lib/blood-test-cell';
import { NumericInputCell } from './NumericInputCell';
import { DraftDateCell } from './DraftDateCell';
import { LpaUnitControl } from './LpaUnitControl';
import { UnitChip } from './UnitChip';
import { describedBy } from '../lib/aria';
import { type FullDate, fullDateToIso, parseIsoToFullDate, columnWords, formatColumnDate } from '../lib/review-dates';
import { type DateKey, type MatrixColumn, type MatrixRow, type CoreCellView, type MatrixCell, editId, replaceKey, buildMatrixModel, rowName, matrixCellKey, matrixRowKey } from '../lib/review-matrix';

// ============================================================================
// ReviewMatrix — the metric × date grid. Uses the same .bt-* CSS as the live
// BloodTestTimeline so visual treatment stays consistent. Existing-history
// cells render greyed-out; new (LLM-extracted) cells render an editable input.
// ============================================================================

interface ReviewMatrixProps {
  matrix: ReturnType<typeof buildMatrixModel>;
  unitSystem: UnitSystem;
  metricUnitOverrides?: Partial<Record<MetricType, CellUnit>>;
  onToggleFieldUnit?: (field: string) => void;
  onChooseLpaUnit: (unit: LpaUnit) => void;
  grading: Grading;
  editedDisplayValues: Record<string, string>;
  coreCellViews: ReadonlyMap<string, CoreCellView>;
  onCellChange: (id: string, value: string, display?: CellUnit) => void;
  onColumnDateChange: (col: MatrixColumn, update: Partial<FullDate>) => void;
  datedColumns: ReadonlySet<DateKey>;
  pickHints: ReadonlyMap<DateKey, string>;
  replaceChecked: Record<string, boolean>;
  heldEqual: ReadonlySet<string>;
  onReplaceToggle: (key: string, on: boolean) => void;
}

export function ReviewMatrix({
  matrix, unitSystem, metricUnitOverrides, onToggleFieldUnit, onChooseLpaUnit, grading,
  editedDisplayValues, coreCellViews, onCellChange, onColumnDateChange, datedColumns, pickHints, replaceChecked, heldEqual, onReplaceToggle,
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
                <MatrixColumnHeader key={col.dateKey} col={col} set={datedColumns.has(col.dateKey)} hint={pickHints.get(col.dateKey)} onDateChange={onColumnDateChange} />
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
            metricUnitOverrides={metricUnitOverrides}
            onToggleFieldUnit={onToggleFieldUnit}
            onChooseLpaUnit={onChooseLpaUnit}
            grading={grading}
            scrollSync={scrollSync}
            editedDisplayValues={editedDisplayValues}
            coreCellViews={coreCellViews}
            onCellChange={onCellChange}
            replaceChecked={replaceChecked}
          heldEqual={heldEqual}
            onReplaceToggle={onReplaceToggle}
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
                metricUnitOverrides={metricUnitOverrides}
                onToggleFieldUnit={onToggleFieldUnit}
                onChooseLpaUnit={onChooseLpaUnit}
                grading={grading}
                scrollSync={scrollSync}
                editedDisplayValues={editedDisplayValues}
                coreCellViews={coreCellViews}
                onCellChange={onCellChange}
                replaceChecked={replaceChecked}
          heldEqual={heldEqual}
                onReplaceToggle={onReplaceToggle}
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
function MatrixColumnHeader({ col, set, hint, onDateChange }: { col: MatrixColumn; set: boolean; hint?: string; onDateChange: (col: MatrixColumn, update: Partial<FullDate>) => void }) {
  if (!col.isNew) {
    return (
      <div className="bt-cell-value bt-cell-context bt-cell-date">
        <span className="bt-value-num num">{formatColumnDate(col.date)}</span>
      </div>
    );
  }
  const onChange = (picked: string) => {
    const parsed = parseIsoToFullDate(picked);
    if (parsed) onDateChange(col, parsed);
  };
  // A column with no past day yet (US-13 AC8) opens an empty picker; an
  // undated previous column (US-12 AC14) names its limits (`pickHints`).
  return (
    <DraftDateCell
      date={col.date.undated ? '' : fullDateToIso(col.date)}
      needsDay={!set}
      placeholder={hint}
      ariaLabel={col.undated ? 'Choose the date of the previous results' : 'Choose column date'}
      onChange={onChange}
    />
  );
}
interface MatrixRowViewProps {
  row: MatrixRow;
  rowIdx: number;
  columns: MatrixColumn[];
  cells: Map<string, MatrixCell>;
  unitSystem: UnitSystem;
  metricUnitOverrides?: Partial<Record<MetricType, CellUnit>>;
  onToggleFieldUnit?: (field: string) => void;
  onChooseLpaUnit: (unit: LpaUnit) => void;
  grading: Grading;
  scrollSync: ReturnType<typeof useMatrixScrollSync>;
  editedDisplayValues: Record<string, string>;
  coreCellViews: ReadonlyMap<string, CoreCellView>;
  onCellChange: (id: string, value: string, display?: CellUnit) => void;
  replaceChecked: Record<string, boolean>;
  heldEqual: ReadonlySet<string>;
  onReplaceToggle: (key: string, on: boolean) => void;
}

function MatrixRowView({
  row, rowIdx, columns, cells, unitSystem, metricUnitOverrides, onToggleFieldUnit, onChooseLpaUnit,
  grading, scrollSync, editedDisplayValues, coreCellViews, onCellChange, replaceChecked, heldEqual, onReplaceToggle,
}: MatrixRowViewProps) {
  const rowKey = matrixRowKey(row);
  const rowDisplay = row.kind === 'core' ? (metricUnitOverrides?.[row.metric] ?? unitSystem) : unitSystem;
  const { label, unitLabel, refLabel } = describeRow(row, rowDisplay, grading);
  // A fixed unit (mmHg, PSA's ng/mL) gets a static chip, not a toggle that does nothing.
  const toggleUnit = row.kind === 'core' && onToggleFieldUnit && hasUnitChoice(row.metric)
    ? () => onToggleFieldUnit(METRIC_TO_FIELD[row.metric])
    : undefined;

  return (
    <div className="bt-row">
      <div className="bt-cell-name">
        <div className="bt-name-label">{label}</div>
        {row.kind === 'core' && row.metric === 'lpa'
          ? <LpaUnitControl unit={rowDisplay as LpaUnit} onChange={onChooseLpaUnit}/>
          : unitLabel && <UnitChip label={unitLabel} onToggle={toggleUnit}/>}
        {refLabel && <div className="bt-ref-label">{refLabel}</div>}
      </div>
      <div ref={el => scrollSync.registerRow(rowIdx, el)} onScroll={scrollSync.onScroll} className="bt-cell-strip">
        <div className="bt-strip-inner">
          {columns.map(col => {
            const cell = cells.get(matrixCellKey(rowKey, col.dateKey)) ?? { state: 'empty' as const };
            const id = cell.state === 'editable' ? editId(cell) : '';
            return (
              <MatrixCellView
                key={col.dateKey}
                cell={cell}
                row={row}
                columnWords={columnWords(col.date)}
                unitSystem={rowDisplay}
                grading={grading}
                editedValue={coreCellViews.get(id)?.text ?? editedDisplayValues[id] ?? ''}
                valueSI={coreCellViews.get(id)?.valueSI}
                validationError={coreCellViews.get(id)?.error}
                comparator={coreCellViews.get(id)?.comparator}
                onCellChange={onCellChange}
                replace={cell.state === 'editable' && !!cell.existing && !!replaceChecked[replaceKey(cell, cell.existing)]}
                alreadySaved={heldEqual.has(id)}
                onReplaceToggle={onReplaceToggle}
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
 *  unit and (if present) a reference range. Caller passes the resolved
 *  display unit (already honours per-metric overrides). */
function describeRow(row: MatrixRow, display: CellUnit, grading: Grading): { label: string; unitLabel: string | null; refLabel: string | null } {
  if (row.kind === 'core') {
    const label = METRIC_LABELS[row.metric] || row.metric;
    const unitLabel = UNIT_DEFS[row.metric] ? cellLabel(row.metric, display) : null;
    // Same reference-range hint InputPanel + BloodTestTimeline show so
    // users have the same context when reviewing as when reading the
    // live timeline, and withheld from a known minor there too (US-07 AC6).
    const refLabel = rowTarget(row.metric, display, grading, null)?.full ?? null;
    return { label, unitLabel, refLabel };
  }
  const refLabel = rowTarget({ referenceLow: row.referenceLow, referenceHigh: row.referenceHigh }, display, grading, null)?.full ?? null;
  return { label: row.displayName, unitLabel: row.unit, refLabel };
}

interface MatrixCellViewProps {
  cell: MatrixCell;
  row: MatrixRow;
  /** The column's date in words (`columnWords`). */
  columnWords: string;
  unitSystem: CellUnit;
  grading: Grading;
  editedValue: string;
  /** The value a core cell saves, which its colour grades (US-13 AC4). */
  valueSI?: number;
  validationError?: string | null;
  /** Keyed by `editId`. */
  onCellChange: (id: string, value: string, display?: CellUnit) => void;
  replace: boolean;
  /** The value as now typed is the saved row's: no Replace is offered. */
  alreadySaved: boolean;
  /** Keyed by `replaceKey`. */
  onReplaceToggle: (key: string, on: boolean) => void;
  /** An untouched limit's symbol, shown before its bound (US-12 AC20). */
  comparator?: Comparator;
}

const MatrixCellView = memo(function MatrixCellView({
  cell, row, columnWords, unitSystem, grading, editedValue, valueSI, validationError, onCellChange, replace, alreadySaved, onReplaceToggle, comparator,
}: MatrixCellViewProps) {
  // Ids of the text that describes the inputs: labels name the test and
  // column, never a value (US-13 AC10).
  const id = useId();
  const [unitId, siId, oldId, newId, printedId, refusedId] = ['unit', 'si', 'old', 'new', 'printed', 'refused'].map(part => `${id}${part}`);
  if (cell.state === 'empty') {
    // NBSP keeps :empty from matching — the theme has a global
    // `div:empty { display: none }` (specificity beats .bt-cell-empty).
    return <div className="bt-cell-value bt-cell-empty">{' '}</div>;
  }
  // Rows merge by slot key (US-35 AC6), so one lab row can hold readings in
  // different units: a cell whose unit is not its row's says its own, and a
  // conflict whose two units differ shows both, so each side is heard with its unit.
  const unitsDiffer = cell.state === 'editable' && cell.kind === 'additional'
    && !!cell.existing?.displayUnit && cell.existing.displayUnit !== cell.displayUnit;
  const showUnit = (unit?: string): unit is string => row.kind === 'additional' && !!unit && (unitsDiffer || unit !== row.unit);
  const unitNote = (unit?: string) => showUnit(unit) && <span id={unitId} className="bt-cell-unit">{unit}</span>;
  if (cell.state === 'context') {
    return (
      <div className="bt-cell-value bt-cell-context" title="Already saved at this date">
        <span className="bt-value-num num">{cell.displayValue}</span>
        {unitNote(cell.displayUnit)}
      </div>
    );
  }
  const isCore = cell.kind === 'core';
  // Stamp the row's display unit so a toggle-after-typing doesn't
  // misconvert the typed value at save time.
  const handleChange = (v: string) => onCellChange(editId(cell), v, isCore ? unitSystem : undefined);
  // A guessed unit (medium) and a doubtful read (low) both ask to be checked (US-21 AC18).
  const lowConfClass = isCore && cell.confidence !== 'high' ? ' bt-cell-low-confidence' : '';
  let storedText: string | null = null;
  let refusedText: string | null = null;
  if (cell.kind === 'additional') {
    // What Save stores for a catalogued test printed in another unit: the write's
    // own canonicalLabRow on the quantity Save takes (`valueSI`: the extracted
    // number while untouched, the typed one once edited) (US-21 AC18). A row the
    // write refuses says the line Save would refuse it with, never the impossible
    // number (US-21 AC21), in the write's order (`toStoredLab`): a count or ceiling
    // fault first (US-21 AC15), then the plausible range (US-21 AC26).
    const entry = resolveLabCatalogEntry(cell.lab.name);
    const printed = entry && valueSI !== undefined
      ? { value: valueSI, unit: cell.lab.unit, referenceLow: cell.referenceLow, referenceHigh: cell.referenceHigh } : null;
    const row = entry && printed ? canonicalLabRow(entry, printed) : null;
    const fault = entry && printed && !row ? labCountFault(entry, printed) : null;
    const bound = entry && printed && row ? labPlausibleBound(entry, printed.value, printed.unit) : null;
    if (fault || bound) { if (!alreadySaved) refusedText = labUnitRefusalLine(entry!.key, cell.lab.unit, fault ?? 'implausible', bound ?? undefined); }
    else if (row && row.factor !== 1) storedText = `${row.stored.value} ${row.stored.unit}`;
  }
  const label = `${rowName(row)} value from ${columnWords}`;
  const newUnitShown = showUnit(cell.displayUnit);

  const input = isCore ? (
    <NumericInputCell
      metric={matrixRowKey(row) as MetricType}
      display={unitSystem}
      grading={grading}
      value={editedValue}
      valueSI={valueSI}
      validationResult={validationError}
      onChange={handleChange}
      comparator={comparator}
      ariaLabel={label}
      ariaDescribedBy={describedBy(cell.printed && printedId)}
      wrapperClass={`bt-cell-input bt-cell-review${lowConfClass}`}
      note={<>{cell.printed && <span id={printedId} className="bt-cell-printed">{cell.printed}</span>}{cell.question && <span className="bt-cell-question">{cell.question}</span>}</>}
    />
  ) : (
    <NumericInputCell
      value={editedValue}
      validationResult={validationError}
      onChange={handleChange}
      comparator={comparator}
      wrapperClass="bt-cell-input bt-cell-review"
      ariaLabel={label}
      ariaDescribedBy={describedBy(newUnitShown && unitId, storedText && siId, refusedText && refusedId)}
      note={<>{unitNote(cell.displayUnit)}{storedText && <span id={siId} className="bt-cell-si">→ {storedText}</span>}{refusedText && <span id={refusedId} className="bt-cell-refused">{refusedText}</span>}</>}
    />
  );

  if (!cell.existing) return input;
  const { display, displayUnit } = cell.existing;

  // Slot already holds a different saved value. Show it, show the file's, and
  // let the user assert the replacement. Layout lives in styles.css.
  return (
    <div className="bt-cell-conflict">
      <span id={oldId} className="bt-value-num num bt-cell-conflict-old">{showUnit(displayUnit) ? `${display} ${displayUnit}` : display}</span>
      {input}
      {/* The new value as text for the Replace box: a description names text, never an input (US-13 AC10). */}
      {!alreadySaved && <span id={newId} className="bt-cell-heard">{editedValue ? `new value ${withComparator(editedValue, comparator)}` : 'no new value'}</span>}
      {!alreadySaved && <label className="bt-cell-conflict-replace">
        <input
          type="checkbox"
          checked={replace}
          onChange={(e) => onReplaceToggle(replaceKey(cell, cell.existing!), e.target.checked)}
          aria-label={`Replace the saved ${rowName(row)} value from ${columnWords}`}
          aria-describedby={describedBy(oldId, newId, newUnitShown && unitId)}
        />
        <span aria-hidden="true">Replace</span>
      </label>}
    </div>
  );
});
