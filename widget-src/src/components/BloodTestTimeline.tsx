// V2 timeline-matrix UI for the blood-test section.
// Rows = metrics; columns = older batches → 2 most recent → draft column.
// Values stored in SI canonical throughout; inputs converted on commit.

import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { type ApiMeasurement, BLOOD_TEST_METRICS, METRIC_TO_FIELD, METRIC_LABELS } from '@roadmap/health-core/mappings';
import type { Comparator } from '@roadmap/health-core/lab-limits';
import { type UnitSystem, type LpaUnit, type MetricType, toCanonicalValue } from '@roadmap/health-core/units';
import type { HealthInputs } from '@roadmap/health-core/types';
import { rowTarget } from '@roadmap/health-core/row-target';
import { savedStatus } from '@roadmap/health-core/row-grade';
import { BT_TIMELINE_DRAFT_KEY } from '../lib/storage';
import { useMatrixDraft } from '../lib/useMatrixDraft';
import { useBloodDraftUnits, type FieldUnitToggle, type UnitSwitchSource } from '../lib/useBloodDraftUnits';
import { useSaveOnLeave } from '../lib/useSaveOnLeave';
import { useScrollToRightOnMount } from '../lib/useScrollToRightOnMount';
import { usePrefillRef } from '../lib/usePrefillRef';
import { slotOf, type CorrectFn, type Refused, type SaveTask } from '../lib/matrix-save';
import {
  type Grading,
  cellFromSI,
  cellLabel,
  cellText,
  cellToSI,
  readTypedValue,
  trendGeometry,
} from '../lib/blood-test-cell';
import { BackfillCell, DraftCell } from './MatrixInputCells';
import { CommitTickButton } from './CommitTickButton';
import { DraftDateCell } from './DraftDateCell';
import { LpaChecks } from './LpaChecks';
import { LpaUnitControl } from './LpaUnitControl';
import type { MoveHeaders } from './MoveTestPanel';
import { UnitChip } from './UnitChip';
import { BatchDateCell, ValueCell, useLiveRegion, SAVE_FAILED, saveErrorText } from './MatrixSavedCells';
export { BatchDateCell, headerDay, useLiveRegion, SAVE_FAILED, SAVE_ERRORS, saveErrorText, ValueCell } from './MatrixSavedCells';

// PSA is omitted from the matrix — rendered separately in the men's section
// elsewhere in the widget.
interface RowConfig {
  field: keyof HealthInputs;
  metric: MetricType;
  label: string;
}

const ROWS: RowConfig[] = BLOOD_TEST_METRICS
  .filter(m => m !== 'psa' && METRIC_TO_FIELD[m])
  .map(m => ({
    field: METRIC_TO_FIELD[m] as keyof HealthInputs,
    metric: m as MetricType,
    label: METRIC_LABELS[m] ?? m,
  }));

// Reference-range labels shown under each metric's unit chip live in
// `packages/health-core/src/reference-hints.ts` (single source of truth, also
// used by InputPanel.tsx).

interface Batch {
  date: string; // ISO yyyy-mm-dd
  values: Partial<Record<MetricType, number>>;
  // Last-write-wins if two rows ever share a (date, metric) — the Map upsert
  // below keeps the most recent.
  ids: Partial<Record<MetricType, string>>;
  /** The values printed as a limit (US-12 AC20). */
  comparators: Partial<Record<MetricType, Comparator>>;
}

function groupByBatch(measurements: ApiMeasurement[]): Batch[] {
  const byDate = new Map<string, Batch>();
  for (const m of measurements) {
    const date = m.recordedAt.slice(0, 10);
    let b = byDate.get(date);
    if (!b) {
      b = { date, values: {}, ids: {}, comparators: {} };
      byDate.set(date, b);
    }
    (b.values as Record<string, number>)[m.metricType] = m.value;
    (b.ids as Record<string, string>)[m.metricType] = m.id;
    const comparators = b.comparators as Record<string, Comparator>;
    if (m.comparator) comparators[m.metricType] = m.comparator;
    else delete comparators[m.metricType];
  }
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

/** A small trend line. A point printed as a limit (`limits[i]`) is a hollow
 *  dot at its bound, left out of the line (US-12 AC20). */
export function Sparkline({ points, limits, width = 44, height = 18 }: { points: number[]; limits?: boolean[]; width?: number; height?: number }) {
  if (points.length < 2) {
    return (
      <svg width={width} height={height} style={{ display: 'block' }}>
        <line x1="0" y1={height / 2} x2={width} y2={height / 2}
              stroke="var(--bt-ink-200)" strokeDasharray="2 3" strokeWidth="1"/>
      </svg>
    );
  }
  // Area path: line + drop down to baseline + back to its start, closed.
  const { coords, exact, line: d, area: areaD } = trendGeometry(points, limits, width, height, height - 2);
  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      {areaD && <path d={areaD} fill="var(--bt-ink-100)" opacity="0.7"/>}
      {areaD && <path d={d} fill="none" stroke="var(--bt-ink-700)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>}
      {exact.length === 1 && <circle cx={exact[0][0]} cy={exact[0][1]} r="1.75" fill="var(--bt-ink-700)"/>}
      {coords.map(([x, y], i) => limits?.[i] && (
        <circle key={i} className="bt-spark-limit" cx={x} cy={y} r="1.75" fill="none" stroke="var(--bt-ink-700)" strokeWidth="1"/>
      ))}
    </svg>
  );
}

export interface BloodTestTimelineProps {
  /** Told whether the grid keeps any typed text, valid or not (US-62 AC11). */
  onHoldsText?: (holds: boolean) => void;
  bloodTestHistory: ApiMeasurement[]; // full history, blood-test metrics only
  unitSystem: UnitSystem;
  unitOverrides: Record<string, UnitSystem>;
  onToggleFieldUnit: FieldUnitToggle;
  /** This device's unit for a field as the page started, before the
   *  record's applied (useUnits): a draft cell kept with no unit was typed in it. */
  startUnitOf?: (field: string) => UnitSystem;
  onUnitSwitch?: UnitSwitchSource; // this tab's switch of the unit system (useUnits' `onSwitch`); a page with none leaves it out
  /** Save the typed values, one task per day. Resolves with what was
   *  refused, slot by slot; those cells are kept for a retry. */
  onSaveBatch: (tasks: SaveTask[]) => Promise<Refused>;
  // ValueCell calls this when the user corrects a saved value. A failure
  // leaves the editor open so the user can retry.
  onCorrectValue?: CorrectFn;
  /** The page's move of a saved column's test to another day (US-04 AC5); without it the headers stay plain. */
  move?: MoveHeaders;
  isSaving: boolean;
  /** Whom the hints and status colours grade for; null for a known minor,
   *  whose values show with neither (US-07 AC6). */
  grading: Grading;
  onUploadClick?: () => void;
  uploadDisabled?: boolean;
  loginUrl?: string;
  // Set true once Phase 2 (cloud) data has arrived. Save is disabled until
  // then to avoid committing a draft over partially-loaded state.
  hasApiResponse?: boolean;
  // When provided, the matrix assigns its `handleSave` (commits draft +
  // backfills) to `flushRef.current` so the parent can flush in-flight
  // typed values before kicking off other save flows (e.g. lab upload).
  flushRef?: MutableRefObject<(() => Promise<void>) | null>;
  // When provided, the matrix exposes an imperative `prefill(metric, value,
  // fromUnit, date)` so the chatbot can inject a value into the draft/backfill
  // (highlighted, for the user to Save). Mirrors the flushRef seam.
  prefillRef?: MutableRefObject<BloodTestPrefillFn | null>;
}

/** Inject a value into the matrix from outside (e.g. the chatbot). `value` is
 *  in `fromUnit`; the matrix converts to its own display unit. `date` null =
 *  today's draft column. Returns the cell key it filled so the parent can
 *  scroll/highlight it. */
export type BloodTestPrefillFn = (
  metric: MetricType,
  value: number,
  fromUnit: UnitSystem,
  date: string | null,
) => string | null;

/** What two typed cells for one test on one day say, on both (US-03 AC3). */
export const SAME_SLOT = 'This test already has a value on that day in another column.';

export function BloodTestTimeline({
  bloodTestHistory, unitSystem, unitOverrides, onToggleFieldUnit, startUnitOf, onUnitSwitch,
  onSaveBatch, onCorrectValue, move, isSaving, grading, onUploadClick, uploadDisabled, loginUrl,
  hasApiResponse, flushRef, prefillRef, onHoldsText,
}: BloodTestTimelineProps) {
  const batches = useMemo(() => groupByBatch(bloodTestHistory), [bloodTestHistory]);
  // Typed values, in the unit they were typed in: a draft, kept on the device.
  // A saved column's cell is on screen while its slot is empty.
  const onScreen = (date: string, metric: MetricType) => {
    const batch = batches.find(b => b.date === date);
    return !!batch && batch.values[metric] == null;
  };
  const rowsUnder = (day: string, metric: MetricType) => ({ [metric]: batches.find(b => b.date === day)?.ids[metric] ?? null });
  const {
    holdsText, draft, backfills, type, setDate: setDraftDate, unitOf, lpaUnitOf, restamp, expected, clashes, taken, settle, refusal,
  } = useMatrixDraft<MetricType>(BT_TIMELINE_DRAFT_KEY, { onScreen, rowsUnder, legacyUnit: m => (m === 'lpa' ? undefined : startUnitOf?.(METRIC_TO_FIELD[m])) });
  // On a phone the grid sits hidden under rows: tell the page it holds typed text (US-62 AC11).
  useEffect(() => { onHoldsText?.(holdsText); }, [holdsText]);
  const [activeCell, setActiveCell] = useState<string | null>(null);
  // A cell leaving clears only its own mark: another may have taken it since
  // (an editor opened from it, the chat's flash).
  const unmark = (cellId: string) => () => setActiveCell(prev => (prev === cellId ? null : prev));
  const [say, cellMessages] = useLiveRegion('bt-cell-messages');
  // The Lp(a) values whose editor is open. The Lp(a) check waits while any
  // is, so the two never correct one row at once (US-05 AC3). Counted from
  // the editors' own open and close, never from the highlight, which another
  // cell takes while an editor is still open, and a refused save leaves behind.
  const [lpaEditors, setLpaEditors] = useState(0);
  // A saved column's move waits while the column holds typed text, the draft
  // dated onto it included, or an open editor (US-04 AC5): the page is told
  // each typed day here, and each editor as it opens and closes.
  const typedDays = useMemo(() => {
    const days = Object.keys(backfills).filter(day => Object.values(backfills[day] ?? {}).some(Boolean));
    return Object.values(draft.values).some(Boolean) ? [...days, draft.date] : days;
  }, [backfills, draft]);
  const onHeld = move?.onHeld;
  useEffect(() => {
    if (!onHeld) return;
    for (const day of typedDays) onHeld(day, true);
    return () => { for (const day of typedDays) onHeld(day, false); };
  }, [typedDays, onHeld]);

  // The units typed cells are read and shown in, Lp(a)'s own included (lib/useBloodDraftUnits).
  const { lpaUnit, pickLpaUnit, toggleUnit, fieldUnit, typedUnit, unreadable, shownText, checkOf } = useBloodDraftUnits({
    rows: ROWS, unitSystem, unitOverrides, onToggleFieldUnit, onUnitSwitch, unitOf, lpaUnitOf, restamp,
  });

  // Per-metric SI series (oldest → newest) + lastSi for trend column.
  // One pass through batches for all rows; downstream lookups are O(1).
  // Hide trend column when no metric has at least two datapoints.
  const trendData = useMemo(() => {
    const series: Partial<Record<MetricType, number[]>> = {};
    const limits: Partial<Record<MetricType, boolean[]>> = {};
    const last: Partial<Record<MetricType, { si: number; comparator?: Comparator }>> = {};
    for (const r of ROWS) {
      const points: number[] = [];
      const limited: boolean[] = [];
      for (const b of batches) {
        const v = b.values[r.metric];
        if (v != null) {
          points.push(v);
          limited.push(!!b.comparators[r.metric]);
          last[r.metric] = { si: v, comparator: b.comparators[r.metric] };
        }
      }
      series[r.metric] = points;
      limits[r.metric] = limited;
    }
    const showTrend = ROWS.some(r => (series[r.metric]?.length ?? 0) >= 2);
    return { series, limits, last, showTrend };
  }, [batches]);
  const { series, limits, last: lastOf, showTrend } = trendData;

  // Columns: existing batches in chronological order, then the always-on draft column.
  // Discriminated on `kind` so `c.ids` only narrows when c.kind === 'batch'.
  const columns = useMemo<Array<
    | { kind: 'batch'; date: string; values: Partial<Record<MetricType, number>>; ids: Partial<Record<MetricType, string>>; comparators: Partial<Record<MetricType, Comparator>> }
    | { kind: 'draft'; date: string; values: Partial<Record<MetricType, string>> }
  >>(
    () => [
      ...batches.map(b => ({ kind: 'batch' as const, date: b.date, values: b.values, ids: b.ids, comparators: b.comparators })),
      { kind: 'draft' as const, date: draft.date, values: draft.values },
    ],
    [batches, draft],
  );

  // Every typed cell with the SI value it saves, in the unit it is read in,
  // or null while it cannot be saved: a number the test does not take, or a
  // second value for one test on one day (the draft dated onto a saved
  // column, and that column's empty cell), which waits for the user to clear
  // one (US-03 AC3). A cell that cannot be saved stays in the draft, with its
  // error; it blocks no other. A saved column's cell that is not on screen is
  // not committed (useMatrixDraft); what was typed into it stays.
  const cellsOf = (column: string | null, typedMap: Partial<Record<MetricType, string>>) =>
    ROWS.flatMap(({ metric, field }) => {
      const typed = typedMap[metric];
      if (!typed || (column !== null && !onScreen(column, metric))) return [];
      const unit = typedUnit(column, metric, field);
      const blocked = !!unreadable(column, metric, field, typed) || ((column ?? draft.date) === draft.date && clashes(metric));
      return [{ column, date: column ?? draft.date, metric, unit: unit ?? fieldUnit(field), si: blocked ? null : cellToSI(metric, readTypedValue(metric, typed, unit!)!, unit!) }];
    });
  const cells = [...Object.entries(backfills).flatMap(([date, typed]) => cellsOf(date, typed)), ...cellsOf(null, draft.values)];
  const ready = cells.filter(c => c.si !== null);
  const hasError = ready.length < cells.length;
  // A refused cell on screen (one off it has nothing left to fix).
  const refused = cells.some(c => refusal([c.column, c.metric]));

  // Single scroll container for the whole matrix. Native horizontal scroll
  // moves all rows in lockstep — sticky name + trend cells stay in place.
  // Draft column visible by default (matrix scrolls to its rightmost edge
  // on first mount).
  const scrollRef = useScrollToRightOnMount<HTMLDivElement>([columns.length]);

  // Each cell is stamped with the unit it is typed in (US-04 AC1, US-05 AC2).
  const unitStamp = (metric: MetricType) => fieldUnit(METRIC_TO_FIELD[metric]);
  const setDraftValue = (metric: MetricType, typed: string) => type([null, metric], typed, unitStamp(metric));
  const setBackfillValue = (batchDate: string, metric: MetricType, typed: string) => type([batchDate, metric], typed, unitStamp(metric));

  // Inject an external value (from the chatbot) into the matrix, routed to
  // the matching existing batch (backfill) or the draft column. Returns the
  // cell key so the parent can scroll/highlight it.
  const prefillCell: BloodTestPrefillFn = (metric, value, fromUnit, date) => {
    const row = ROWS.find(r => r.metric === metric);
    if (!row) return null; // e.g. PSA — not in this matrix
    // An Lp(a) cell takes the number as stated, stamped with the unit it was
    // stated in (its system's label; mg/L arrives as mg/dL), and shows it in
    // the field's unit: rounded into that unit first, 49.6 mg/dL (124 nmol/L)
    // read "50" and saved 125 (US-05 AC2). Other cells are re-expressed in
    // the field's unit, rounded, and stamped with it.
    const stated = metric === 'lpa' ? cellLabel(metric, fromUnit) as LpaUnit : fieldUnit(row.field);
    // toPrecision strips the float noise of a rescale (498 mg/L × 0.1 is 49.800000000000004).
    const typed = metric === 'lpa' ? String(Number(value.toPrecision(12))) : cellText(metric, toCanonicalValue(metric, value, fromUnit), stated);

    // Use the backfill column only when an existing batch on that date has an
    // EMPTY cell for this metric. If a value already exists there, route to the
    // draft column instead (the user reviews + Saves; a real correction goes
    // through the click-to-edit ValueCell path, not chat pre-fill).
    const existingBatch = date ? batches.find(b => b.date === date) : undefined;
    if (date && existingBatch && existingBatch.values[metric] == null) {
      type([date, metric], typed, stated, false);
      const cellId = `${date}.${metric}`;
      setActiveCell(cellId);
      return cellId;
    }
    if (date) setDraftDate(date);
    type([null, metric], typed, stated, false);
    const cellId = `draft.${metric}`;
    setActiveCell(cellId);
    return cellId;
  };

  usePrefillRef(prefillCell, prefillRef);

  const saveDisabledByLoad = hasApiResponse === false;

  const handleSave = async () => {
    if (ready.length === 0 || isSaving || saveDisabledByLoad) return;
    // The cells that can be saved, each on its day with the row it expects
    // there; the parent routes each value (matrix-save.ts) and answers slot
    // by slot. What landed leaves the draft; what was refused stays, with why
    // (US-03 AC4).
    const refusedSlots = await onSaveBatch(ready.map(c => ({
      date: c.date, values: { [c.metric]: c.si! }, expected: expected([c.column, c.metric]), unit: c.unit,
    })));
    settle(ready.map(c => {
      const status = refusedSlots.get(slotOf(c.date, c.metric));
      return [[c.column, c.metric], status && saveErrorText(status)];
    }));
    if (refusedSlots.size === 0) setActiveCell(null);
  };

  // The upload flow commits the draft before its own save (flushRef).
  usePrefillRef(handleSave, flushRef);

  // The draft is committed when the user leaves the matrix, presses Enter or
  // the tick; never while the user is still in it, and never because the page
  // hides (US-03 AC5).
  const rootRef = useRef<HTMLDivElement>(null);
  useSaveOnLeave(rootRef, handleSave);
  const saveNow = () => { void handleSave(); };

  return (
    <div ref={rootRef} className="bt-timeline">
      <div className="bt-timeline-header">
        <h3 className="bt-timeline-title" tabIndex={-1}>Blood Test Results</h3>
        <div className="bt-timeline-actions">
          {uploadDisabled ? (
            <div className="upload-lab-wrapper">
              <button
                type="button"
                className="btn-primary upload-lab-btn upload-lab-btn--disabled"
                disabled
              >Upload your lab results</button>
              <div className="upload-lab-tooltip">
                <p>Upload health records to automatically extract blood tests, scan results, and more.</p>
                {loginUrl && <a href={loginUrl} className="upload-lab-tooltip-link">Log in to use this feature →</a>}
              </div>
            </div>
          ) : onUploadClick ? (
            <button type="button" className="btn-primary upload-lab-btn"
                    onClick={onUploadClick}>Upload your lab results</button>
          ) : null}
          {isSaving && (
            <span className="bt-saving-indicator" aria-live="polite">Saving…</span>
          )}
          {hasError && !isSaving && (
            <span className="bt-save-error" aria-live="polite">Fix invalid values</span>
          )}
          {refused && !isSaving && !hasError && (
            <span className="bt-save-error" aria-live="polite">{SAVE_FAILED}</span>
          )}
          {ready.length > 0 && !isSaving && (
            <CommitTickButton variant="matrix" ariaLabel="Save typed values" onClick={saveNow}/>
          )}
        </div>
      </div>
      <div className="bt-timeline-divider"/>

      <div className="bt-timeline-body">
        <div ref={scrollRef} className="bt-timeline-scroll">
          {/* Pixel-width wrapper so rows can use `width: 100%` instead of
              `width: max-content` — the latter breaks `position: sticky`
              on iOS WebKit. CSS calc consumes `--bt-col-count`. */}
          <div className="bt-timeline-scroll-inner" style={{ '--bt-col-count': columns.length } as React.CSSProperties}>
          {/* Header row */}
          <div className="bt-row bt-header-row">
            <div className="bt-cell-name bt-cell-header">Metric</div>
            {columns.map((c, i) => {
              if (c.kind === 'draft') {
                return <DraftDateCell key="draft" date={c.date} onChange={setDraftDate} label="New" ariaLabel="Choose draft batch date"/>;
              }
              const isPinnedRecent = i === columns.length - 2;
              return <BatchDateCell key={c.date} date={c.date} pinned={isPinnedRecent} move={move}/>;
            })}
            <div className="bt-row-filler"/>
            {showTrend && <div className="bt-cell-trend bt-cell-header">Trend</div>}
          </div>

          {/* Body — metric rows */}
          {ROWS.map((row, rowIdx) => {
            const display = fieldUnit(row.field);
            const ref = rowTarget(row.metric, display, grading, null)?.full ?? null;

            // Sparkline points in display units. Series is precomputed in SI;
            // converting to display unit here keeps the y-axis monotonic when
            // the user toggles SI ↔ conventional.
            const sparkPoints = (series[row.metric] ?? [])
              .map(siVal => cellFromSI(row.metric, siVal, display));
            const last = lastOf[row.metric];
            const lastStatus = last ? savedStatus(row.metric, last.si, last.comparator, grading) : null;

            return (
              <div key={row.field} className={`bt-row${rowIdx === ROWS.length - 1 ? ' bt-row-last' : ''}`} data-metric={row.metric}>
                <div className="bt-cell-name">
                  <div className="bt-name-label">{row.label}</div>
                  {row.metric === 'lpa'
                    ? <LpaUnitControl unit={lpaUnit} onChange={pickLpaUnit}/>
                    : <UnitChip label={cellLabel(row.metric, display)} onToggle={() => toggleUnit(row.metric, row.field)}/>}
                  {ref && <div className="bt-ref-label">{ref}</div>}
                </div>
                {columns.map((c, colIdx) => {
                  if (c.kind === 'draft') {
                    const typed = draft.values[row.metric] ?? '';
                    const cellId = `draft.${row.metric}`;
                    return (
                      <DraftCell
                        key={cellId}
                        metric={row.metric}
                        display={display}
                        grading={grading}
                        value={shownText(null, row.metric, row.field, typed)}
                        validationResult={checkOf(null, row.metric, row.field, typed)}
                        valueSI={cells.find(cell => cell.column === null && cell.metric === row.metric)?.si ?? undefined}
                        error={unreadable(null, row.metric, row.field, typed) ?? (clashes(row.metric) || taken(row.metric) ? SAME_SLOT : refusal([null, row.metric]))}
                        active={activeCell === cellId}
                        onFocus={() => setActiveCell(cellId)}
                        onBlur={unmark(cellId)}
                        onEnter={saveNow}
                        onChange={v => setDraftValue(row.metric, v)}
                      />
                    );
                  }
                  const v = c.values[row.metric];
                  if (v == null) {
                    const cellId = `${c.date}.${row.metric}`;
                    const typed = backfills[c.date]?.[row.metric] ?? '';
                    return (
                      <BackfillCell
                        key={cellId}
                        metric={row.metric}
                        display={display}
                        value={shownText(c.date, row.metric, row.field, typed)}
                        validationResult={checkOf(c.date, row.metric, row.field, typed)}
                        error={unreadable(c.date, row.metric, row.field, typed) ?? (c.date === draft.date && clashes(row.metric) ? SAME_SLOT : refusal([c.date, row.metric]))}
                        active={activeCell === cellId}
                        onFocus={() => setActiveCell(cellId)}
                        onBlur={unmark(cellId)}
                        onEnter={saveNow}
                        onChange={v => setBackfillValue(c.date, row.metric, v)}
                      />
                    );
                  }
                  // c.kind === 'batch' here — the 'draft' branch returned above
                  const comparator = c.kind === 'batch' ? c.comparators[row.metric] : undefined;
                  const status = savedStatus(row.metric, v, comparator, grading);
                  const isPinned = colIdx === columns.length - 2;
                  const cellId = `${c.date}.${row.metric}`;
                  const rowId = c.kind === 'batch' ? c.ids[row.metric] : undefined;
                  return (
                    <ValueCell
                      key={cellId}
                      metric={row.metric}
                      display={display}
                      grading={grading}
                      value={v}
                      comparator={comparator}
                      rowId={rowId}
                      status={status}
                      pinned={isPinned}
                      onActivate={() => {
                        setActiveCell(cellId);
                        onHeld?.(c.date, true);
                        if (row.metric === 'lpa') setLpaEditors(n => n + 1);
                      }}
                      onDeactivate={() => {
                        unmark(cellId)();
                        onHeld?.(c.date, false);
                        if (row.metric === 'lpa') setLpaEditors(n => n - 1);
                      }}
                      onCorrect={onCorrectValue}
                      say={say}
                    />
                  );
                })}
                <div className="bt-row-filler"/>
                {showTrend && (
                  <div className="bt-cell-trend">
                    <Sparkline points={sparkPoints} limits={limits[row.metric]}/>
                    <span className={`bt-status-tick bt-status-${lastStatus ?? 'none'}`}/>
                  </div>
                )}
              </div>
            );
          })}
          </div>
        </div>
      </div>
      {cellMessages}
      {onCorrectValue && <LpaChecks rows={bloodTestHistory} unitSystem={unitSystem} onCorrect={onCorrectValue} waiting={lpaEditors > 0}/>}
    </div>
  );
}
