// V2 timeline-matrix UI for the blood-test section.
// Rows = metrics; columns = older batches → 2 most recent → draft column.
// Values stored in SI canonical throughout; inputs converted on commit.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject, type ReactElement } from 'react';
import {
  type ApiMeasurement,
  type UnitSystem,
  type LpaUnit,
  type MetricType,
  type HealthInputs,
  healthInputSchema,
  toCanonicalValue,
  BLOOD_TEST_METRICS,
  METRIC_TO_FIELD,
  METRIC_LABELS,
  parseLocalisedNumber,
  reportedToCanonical,
  UNIT_DEFS,
} from '@roadmap/health-core';
import { formatShortDate, MONTHS_SHORT } from '../lib/constants';
import { BT_TIMELINE_DRAFT_KEY } from '../lib/storage';
import { useDraftMirror, useMatrixDraft } from '../lib/useMatrixDraft';
import { useSaveOnLeave } from '../lib/useSaveOnLeave';
import { useScrollToRightOnMount } from '../lib/useScrollToRightOnMount';
import { usePrefillRef } from '../lib/usePrefillRef';
import { slotOf, type CorrectFn, type Refused, type SaveTask } from '../lib/matrix-save';
import type { CorrectStatus } from '../storage/roadmap-store';
import {
  type CellUnit,
  type Grading,
  type Status,
  blockBadNumericKeys,
  cellFromSI,
  cellHint,
  cellLabel,
  cellText,
  cellToSI,
  formatLabValue,
  readTypedValue,
  sameAsSaved,
  validateTypedValue,
  statusOf,
} from '../lib/blood-test-cell';
import { keepLpaAsIs, lpaRowsToCheck, useLpaUnit, type LpaCheck } from '../lib/lpa-unit';
import { trackProductEvent } from '../lib/server-api';
import { NumericInputCell } from './NumericInputCell';
import { CommitTickButton } from './CommitTickButton';
import { DraftDateCell } from './DraftDateCell';
import { LpaUnitControl } from './LpaUnitControl';
import { UnitChip } from './UnitChip';

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
}

function groupByBatch(measurements: ApiMeasurement[]): Batch[] {
  const byDate = new Map<string, Batch>();
  for (const m of measurements) {
    const date = m.recordedAt.slice(0, 10);
    let b = byDate.get(date);
    if (!b) {
      b = { date, values: {}, ids: {} };
      byDate.set(date, b);
    }
    (b.values as Record<string, number>)[m.metricType] = m.value;
    (b.ids as Record<string, string>)[m.metricType] = m.id;
  }
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

export function Sparkline({ points, width = 44, height = 18 }: { points: number[]; width?: number; height?: number }) {
  if (points.length < 2) {
    return (
      <svg width={width} height={height} style={{ display: 'block' }}>
        <line x1="0" y1={height / 2} x2={width} y2={height / 2}
              stroke="var(--bt-ink-200)" strokeDasharray="2 3" strokeWidth="1"/>
      </svg>
    );
  }
  const min = Math.min(...points), max = Math.max(...points);
  const range = max - min || 1;
  const pad = 2;
  const w = width - pad * 2, h = height - pad * 2;
  const coords = points.map((v, i) => {
    const x = pad + (i / (points.length - 1)) * w;
    const y = pad + h - ((v - min) / range) * h;
    return [x, y] as const;
  });
  const d = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  // Area path: line + drop down to baseline + back to start, closed.
  const last = coords[coords.length - 1];
  const areaD = `${d} L${last[0].toFixed(1)},${height - pad} L${pad},${height - pad} Z`;
  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      <path d={areaD} fill="var(--bt-ink-100)" opacity="0.7"/>
      <path d={d} fill="none" stroke="var(--bt-ink-700)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

export interface BloodTestTimelineProps {
  bloodTestHistory: ApiMeasurement[]; // full history, blood-test metrics only
  unitSystem: UnitSystem;
  unitOverrides: Record<string, UnitSystem>;
  onToggleFieldUnit: (field: string) => void;
  /** Save the typed values, one task per day. Resolves with what was
   *  refused, slot by slot; those cells are kept for a retry. */
  onSaveBatch: (tasks: SaveTask[]) => Promise<Refused>;
  // ValueCell calls this when the user corrects a saved value. A failure
  // leaves the editor open so the user can retry.
  onCorrectValue?: CorrectFn;
  // The draft values the plan and the chat may read, in SI; undefined leaves
  // the field to the record.
  onDraftValue: (field: keyof HealthInputs, siValue: number | undefined, day?: string) => void;
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

/** What an Lp(a) cell restored from before its unit was kept says (US-05 AC2). */
export const UNCLEAR_UNIT = 'Re-enter this value: its unit is unclear after an update.';

const MONTH_LABELS = MONTHS_SHORT.map(m => m.label);

export function BloodTestTimeline({
  bloodTestHistory, unitSystem, unitOverrides, onToggleFieldUnit,
  onSaveBatch, onCorrectValue, onDraftValue, isSaving, grading, onUploadClick, uploadDisabled, loginUrl,
  hasApiResponse, flushRef, prefillRef,
}: BloodTestTimelineProps) {
  const batches = useMemo(() => groupByBatch(bloodTestHistory), [bloodTestHistory]);
  // Typed values, in the unit they were typed in: a draft, kept on the device.
  // A saved column's cell is on screen while its slot is empty.
  const onScreen = (date: string, metric: MetricType) => {
    const batch = batches.find(b => b.date === date);
    return !!batch && batch.values[metric] == null;
  };
  const rowsUnder = (day: string, metric: MetricType) => ({ [metric]: batches.find(b => b.date === day)?.ids[metric] ?? null });
  const latestDay = (metric: MetricType) => [...batches].reverse().find(b => b.values[metric] != null)?.date;
  const {
    draft, backfills, type, setDate: setDraftDate, lpaUnitOf, restamp, expected, clashes, taken, lends, settle, refusal,
  } = useMatrixDraft<MetricType>(BT_TIMELINE_DRAFT_KEY, { onScreen, rowsUnder, latestDay });
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

  // Lp(a) has three units on its own control, kept in the record (US-05 AC2);
  // every other field, the two-way toggle.
  const [lpaUnit, chooseLpaUnit] = useLpaUnit(unitSystem);
  // A unit chosen here says what the numbers typed in it are in (Brad,
  // 2026-10-13): "type 40, click mg/dL" is 40 mg/dL, as in this matrix's
  // other draft cells (the vitals drafts still keep the quantity). Another device's choice keeps each cell's own unit.
  // Only a number typed by hand on this page is re-read; one the chat filled
  // or the device restored keeps its quantity (useMatrixDraft's `restamp`).
  const pickLpaUnit = (unit: LpaUnit) => {
    restamp('lpa', lpaUnit, unit);
    chooseLpaUnit(unit);
  };
  const fieldUnit = (field: string): CellUnit => (field === 'lpa' ? lpaUnit : unitOverrides[field] ?? unitSystem);
  // The unit a typed cell is read in. An Lp(a) cell keeps the one it was typed
  // in, and one restored from before that was kept has none: its value waits
  // to be typed again, never guessed (US-05 AC2).
  const typedUnit = (column: string | null, metric: MetricType, field: string): CellUnit | undefined =>
    metric === 'lpa' ? lpaUnitOf([column, metric]) : fieldUnit(field);
  // Why a typed cell cannot be read: its unit unclear, or its number out of
  // range in the unit it was typed in. The cell shows this whatever unit it
  // is shown in: 750.1 nmol/L reads "300.0" mg/dL, inside that range.
  const unreadable = (column: string | null, metric: MetricType, field: string, typed: string) => {
    if (!typed) return null;
    const unit = typedUnit(column, metric, field);
    return unit ? validateTypedValue(metric, typed, unit).error : UNCLEAR_UNIT;
  };
  // What a typed cell shows: as typed, or, for an Lp(a) cell typed in another
  // unit, the same quantity in the field's unit.
  const shownText = (column: string | null, metric: MetricType, field: string, typed: string) => {
    const unit = typedUnit(column, metric, field);
    const n = unit ? readTypedValue(metric, typed, unit) : undefined;
    return !unit || unit === fieldUnit(field) || n === undefined ? typed : cellText(metric, cellToSI(metric, n, unit), fieldUnit(field));
  };

  // Per-metric SI series (oldest → newest) + lastSi for trend column.
  // One pass through batches for all rows; downstream lookups are O(1).
  // Hide trend column when no metric has at least two datapoints.
  const trendData = useMemo(() => {
    const series: Partial<Record<MetricType, number[]>> = {};
    const lastSi: Partial<Record<MetricType, number>> = {};
    for (const r of ROWS) {
      const points: number[] = [];
      let last: number | undefined;
      for (const b of batches) {
        const v = b.values[r.metric];
        if (v != null) {
          points.push(v);
          last = v;
        }
      }
      series[r.metric] = points;
      lastSi[r.metric] = last;
    }
    const showTrend = ROWS.some(r => (series[r.metric]?.length ?? 0) >= 2);
    return { series, lastSi, showTrend };
  }, [batches]);
  const { series, lastSi, showTrend } = trendData;

  // Columns: existing batches in chronological order, then the always-on draft column.
  // Discriminated on `kind` so `c.ids` only narrows when c.kind === 'batch'.
  const columns = useMemo<Array<
    | { kind: 'batch'; date: string; values: Partial<Record<MetricType, number>>; ids: Partial<Record<MetricType, string>> }
    | { kind: 'draft'; date: string; values: Partial<Record<MetricType, string>> }
  >>(
    () => [
      ...batches.map(b => ({ kind: 'batch' as const, date: b.date, values: b.values, ids: b.ids })),
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

  // What the plan and the chat read of the draft (US-03 AC6, `lends`): a
  // value the test can take, clear of clashes (`si`), and the day it is dated
  // (US-07 AC7: a creatinine's day decides which eGFR the plan reads).
  useDraftMirror(ROWS.map(({ metric, field }) => {
    const si = lends(metric) ? cells.find(c => c.column === null && c.metric === metric)?.si ?? undefined : undefined;
    return [field, si, si === undefined ? undefined : draft.date];
  }), onDraftValue);

  // An Lp(a) cell is stamped with the unit it is typed in (US-05 AC2).
  const unitStamp = (metric: MetricType) => (metric === 'lpa' ? lpaUnit : undefined);
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
    // read "50" and saved 125 (US-05 AC2). Other cells read their text in the
    // field's unit, so the value is re-expressed there, rounded.
    const stated = metric === 'lpa' ? cellLabel(metric, fromUnit) as LpaUnit : undefined;
    // toPrecision strips the float noise of a rescale (498 mg/L × 0.1 is 49.800000000000004).
    const typed = stated ? String(Number(value.toPrecision(12))) : cellText(metric, toCanonicalValue(metric, value, fromUnit), fieldUnit(row.field));

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
    type([null, metric], typed, stated, false); // the plan and the chat read it while it may stand in
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
      return [[c.column, c.metric], status && SAVE_ERRORS[status]];
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
              return <BatchDateCell key={c.date} date={c.date} pinned={isPinnedRecent}/>;
            })}
            <div className="bt-row-filler"/>
            {showTrend && <div className="bt-cell-trend bt-cell-header">Trend</div>}
          </div>

          {/* Body — metric rows */}
          {ROWS.map((row, rowIdx) => {
            const display = fieldUnit(row.field);
            const ref = cellHint(row.metric, display, grading);

            // Sparkline points in display units. Series is precomputed in SI;
            // converting to display unit here keeps the y-axis monotonic when
            // the user toggles SI ↔ conventional.
            const sparkPoints = (series[row.metric] ?? [])
              .map(siVal => cellFromSI(row.metric, siVal, display));
            const last = lastSi[row.metric];
            const lastStatus = last != null ? statusOf(row.metric, last, grading) : null;

            return (
              <div key={row.field} className={`bt-row${rowIdx === ROWS.length - 1 ? ' bt-row-last' : ''}`} data-metric={row.metric}>
                <div className="bt-cell-name">
                  <div className="bt-name-label">{row.label}</div>
                  {row.metric === 'lpa'
                    ? <LpaUnitControl unit={lpaUnit} onChange={pickLpaUnit}/>
                    : <UnitChip label={cellLabel(row.metric, display)} onToggle={() => onToggleFieldUnit(row.field)}/>}
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
                        error={unreadable(c.date, row.metric, row.field, typed) ?? (c.date === draft.date && clashes(row.metric) ? SAME_SLOT : refusal([c.date, row.metric]))}
                        active={activeCell === cellId}
                        onFocus={() => setActiveCell(cellId)}
                        onBlur={unmark(cellId)}
                        onEnter={saveNow}
                        onChange={v => setBackfillValue(c.date, row.metric, v)}
                      />
                    );
                  }
                  const status = statusOf(row.metric, v, grading);
                  const isPinned = colIdx === columns.length - 2;
                  const cellId = `${c.date}.${row.metric}`;
                  // c.kind === 'batch' here — the 'draft' branch returned above
                  const rowId = c.kind === 'batch' ? c.ids[row.metric] : undefined;
                  return (
                    <ValueCell
                      key={cellId}
                      metric={row.metric}
                      display={display}
                      grading={grading}
                      value={v}
                      rowId={rowId}
                      status={status}
                      pinned={isPinned}
                      onActivate={() => {
                        setActiveCell(cellId);
                        if (row.metric === 'lpa') setLpaEditors(n => n + 1);
                      }}
                      onDeactivate={() => {
                        unmark(cellId)();
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
                    <Sparkline points={sparkPoints}/>
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

// US-05 AC3: one question per Lp(a) row typed while the US field was labelled
// mg/L (lpaRowsToCheck), under the matrix's last row, Lp(a). The user answers
// with a number and its unit, so a row stored right (a connector's 120 nmol/L)
// has an honest answer that writes nothing. "My report says <typed> mg/dL",
// "... nmol/L" or "... mg/L" is a correction at today's factor, as a
// click-to-correct makes one (US-04), offered only when the record takes its
// value. A report above 300 mg/dL saves the record's ceiling, 750 nmol/L.
// "Neither", or any answer that would save what is stored, keeps the row and
// is remembered on this device.
type ReportUnit = 'mg/dL' | 'nmol/L' | 'mg/L';
const LPA_MAX = UNIT_DEFS.lpa.validationRange.si.max;

function LpaChecks({ rows, unitSystem, onCorrect, waiting }: {
  rows: ApiMeasurement[]; unitSystem: UnitSystem; onCorrect: CorrectFn; waiting: boolean;
}) {
  const [answered, setAnswered] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  // After an answer every answer button rests a moment, so the second click
  // of a double click never answers the notice that moved into its place
  // (adversary R1).
  const [resting, setResting] = useState(false);
  const restTimer = useRef<number>();
  useEffect(() => () => window.clearTimeout(restTimer.current), []);
  const rest = () => {
    setResting(true);
    window.clearTimeout(restTimer.current);
    restTimer.current = window.setTimeout(() => setResting(false), 600);
  };
  const [errors, setErrors] = useState<Record<string, string>>({});
  // What the last answer did, said in a region that outlives its notice: on
  // the page from the first question, so an answer is heard, and kept once
  // the last notice goes.
  const [say, status] = useLiveRegion('lpa-check-status');
  const [asked, setAsked] = useState(false);
  // Where an answer was given, so the focus can move on once its notice goes.
  const focusFrom = useRef<{ root: Element; index: number } | null>(null);
  const checks = useMemo(
    () => lpaRowsToCheck(rows, unitSystem).filter(check => !answered.includes(check.row.id)),
    [rows, unitSystem, answered]);

  // After an answer the focus goes to the next notice, else to the Lp(a)
  // row's latest value, else the matrix heading; after a refusal it can retry, back to its
  // own notice (a button disabled while saving drops the focus). Never to the page.
  useLayoutEffect(() => {
    const from = focusFrom.current;
    if (!from) return;
    focusFrom.current = null;
    const cells = from.root.querySelectorAll<HTMLElement>('[data-metric="lpa"] .bt-cell-clickable');
    (from.root.querySelectorAll<HTMLElement>('.lpa-check')[from.index]
      ?? cells[cells.length - 1]
      ?? from.root.querySelector<HTMLElement>('.bt-timeline-title'))?.focus();
  });

  // A report in nmol/L, clean of float noise (12 significant digits).
  const nmolOf = (typed: number, unit: ReportUnit) => Number(reportedToCanonical('lpa', typed, unit)!.valueSI.toPrecision(12));
  // What an answer writes, as its button says: mg/dL past the ceiling saves the ceiling.
  const saves = (typed: number, unit: ReportUnit) => unit === 'mg/dL' ? Math.min(nmolOf(typed, unit), LPA_MAX) : nmolOf(typed, unit);

  const answer = async (event: React.MouseEvent, { row, typed }: LpaCheck, index: number, unit: ReportUnit | 'keep') => {
    if (event.detail > 1) return; // the second click of a double click
    rest();
    const root = event.currentTarget.closest('.bt-timeline')!;
    // An answer that would save what is stored writes nothing: kept.
    const kept = unit === 'keep' || saves(typed, unit) === Number(row.value.toPrecision(12));
    if (kept) keepLpaAsIs(row.id);
    else {
      setSaving(true);
      const status = await onCorrect(row.id, saves(typed, unit));
      setSaving(false);
      if (status === 'changed') {
        // Replaced on another device: the page re-reads the record and the
        // notice goes, so the reason is said where it outlives it (adversary
        // R8), and the focus goes to the next notice or there (adversary R5).
        say(CHECK_CHANGED);
        (root.querySelectorAll<HTMLElement>('.lpa-check')[index + 1] ?? root.querySelector<HTMLElement>('.lpa-check-status'))?.focus();
        return;
      }
      if (status !== 'ok') {
        focusFrom.current = { root, index };
        setErrors(e => ({ ...e, [row.id]: SAVE_ERRORS[status] }));
        return;
      }
    }
    // Names the result's day, so a second answer in a row reads differently.
    const day = formatShortDate(row.recordedAt);
    say(kept ? `Kept the result from ${day} as saved.` : `Saved the result from ${day}.`);
    trackProductEvent('lpa_check_answered', { answer: kept ? 'keep' : unit }); // after the outcome; the label, never a value
    focusFrom.current = { root, index };
    rest();
    setAnswered(ids => [...ids, row.id]);
  };

  const notices = checks.map((check, index) => {
    const offered = (['mg/dL', 'nmol/L', 'mg/L'] as const)
      .filter(unit => healthInputSchema.shape.lpa.safeParse(saves(check.typed, unit)).success);
    const over = nmolOf(check.typed, 'mg/dL') > LPA_MAX;
    const label = (unit: ReportUnit) => `My report says ${check.typed} ${unit}` + (unit === 'nmol/L' ? ''
      : unit === 'mg/dL' && over ? ` (saves ${LPA_MAX} nmol/L, the highest value this tool records)`
        : ` (saves ${saves(check.typed, unit)} nmol/L)`);
    return (
    <div key={check.row.id} className="screening-notice lpa-check" tabIndex={-1}>
      <p>
        {`Please check this Lp(a) result from ${formatShortDate(check.row.recordedAt)}. It is saved as`
          + ` ${check.row.value.toFixed(0)} nmol/L. Between 6 September and 13 October this box was labelled mg/L,`
          + ' so a number copied from a lab report may have been saved wrongly. What does your lab report say?'}
      </p>
      <div className="alr-add-actions">
        {offered.map(unit => (
          <button key={unit} type="button" className="alr-add-cancel" disabled={saving || resting || waiting}
            onClick={e => void answer(e, check, index, unit)}>{label(unit)}</button>
        ))}
        <button type="button" className="alr-add-cancel" disabled={saving || resting || waiting}
          onClick={e => void answer(e, check, index, 'keep')}>Neither of these (keep as saved)</button>
        {waiting && <span className="lpa-check-wait">Finish editing the Lp(a) value first.</span>}
      </div>
      {over && <p className="lpa-check-note">This tool records Lp(a) up to 300 mg/dL (750 nmol/L).
        If your report shows a higher number, that result is very high: please discuss it with your doctor.</p>}
      <p className="lpa-check-note">You can also correct any value by clicking it in the table.</p>
      {/* A p, never a div: the storefront theme hides an empty div (div:empty). */}
      <p className="alr-add-notice lpa-check-note" aria-live="polite">{errors[check.row.id] || '\u00a0'}</p>
    </div>
    );
  });
  if (checks.length > 0 && !asked) setAsked(true);
  return <>{notices}{asked && status}</>;
}

/** What the check says when another device replaced the result it was answering (US-05 AC3). */
const CHECK_CHANGED = 'This result changed on another device. Nothing was saved.';

// Exported so StartingInfoVitals can reuse the exact same saved-date header
// cell — keeps the two matrices pixel-identical without copy-paste drift.
export function BatchDateCell({ date, pinned }: { date: string; pinned: boolean }) {
  const d = new Date(date + 'T00:00');
  const day = d.getDate();
  const mon = MONTH_LABELS[d.getMonth()];
  const yr = String(d.getFullYear()).slice(-2);
  return (
    <div className={`bt-cell-value bt-cell-date${pinned ? ' bt-cell-pinned' : ''}`}>
      <div className="bt-date-day">{day} {mon}</div>
      <div className="bt-date-year">'{yr}</div>
    </div>
  );
}

interface ValueCellProps {
  /** A core metric: shown in `display` units and range-checked. Absent for a
   *  lab value, which is edited in the unit it is stored in. */
  metric?: MetricType;
  display?: CellUnit;
  /** Whom the editor's status preview grades for. Omit it, or pass null (a
   *  known minor, US-07 AC6), for no preview. */
  grading?: Grading;
  /** As stored: SI for a core metric, the stored unit for a lab value. */
  value: number;
  /** A lab value's unit, shown in the cell (a series whose reports used more
   *  than one unit). */
  unit?: string;
  rowId?: string;
  status: Status;
  pinned: boolean;
  onActivate?: () => void;
  onDeactivate?: () => void;
  onCorrect?: CorrectFn;
  /** Says a message in the matrix's live region (`useLiveRegion`). */
  say?: (message: string) => void;
}

/** A polite live region (`role="status"`, a p) that says every message, a
 *  repeat too: it is cleared, then set a task later, so the page changes
 *  each time (Codex R2, adversary R3). A non-breaking space holds it while it
 *  says nothing: the storefront theme hides `div:empty`, and may hide
 *  `p:empty`. Each matrix renders one for its cells' messages
 *  (`bt-cell-messages`, hidden on screen: each message shows in its cell;
 *  US-04 AC1, US-05 AC2), on the page from the first render so a screen
 *  reader hears the first. Hands back how to say one, and the region. */
export function useLiveRegion(className: string): [(message: string) => void, ReactElement] {
  const [said, setSaid] = useState('');
  const timer = useRef<number>();
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const say = useCallback((message: string) => {
    window.clearTimeout(timer.current);
    setSaid('');
    timer.current = window.setTimeout(() => setSaid(message), 0);
  }, []);
  // Focusable from script only: the Lp(a) check moves the focus here when its notice goes.
  return [say, <p className={className} role="status" tabIndex={-1}>{said || '\u00a0'}</p>];
}

/** What a matrix says when a save did not all land (US-03 AC4). */
export const SAVE_FAILED = 'Some values did not save. Try again.';

/** What an editor closed by a unit switch says (US-05 AC2). */
const UNIT_CHANGED = 'The unit changed, so your edit was not saved. Type it again in the new unit.';
/** What an editor left for its own unit control says (US-05 AC2). */
const UNIT_FIRST = 'Not saved: choose the unit first, then type the value.';

/** What a refused correction says, wherever one is made. */
export const SAVE_ERRORS: Record<Exclude<CorrectStatus, 'ok'>, string> = {
  changed: 'This value changed on another device, so your edit was not saved.',
  invalid: 'That value is outside the range this record takes.',
  error: 'Could not save. Check your connection and try again.',
};

// The saved-value editor, one for every matrix: the blood tests, the vitals
// (StartingInfoVitals) and the additional lab rows. Click a value to correct
// it in place: a FHIR correction, never an edit of the saved row.
export function ValueCell({
  metric, display, grading, value, unit, rowId, status, pinned, onActivate, onDeactivate, onCorrect, say,
}: ValueCellProps) {
  // `typed === null` ⇒ read-only; otherwise the in-place edit form is open.
  // One field replaces the old (editing, typed) pair — impossible state gone.
  const [typed, setTyped] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // The row the editor opened on, which its correction names: the store
  // refuses it once another writer has replaced that row (US-04 AC1).
  const openedOn = useRef<string>();
  const blurTimerRef = useRef<number | null>(null);
  // A typed correction is saved only in the unit shown when the editor
  // opened, never across a unit change (US-05 AC2, US-04 AC1). The unit
  // shown then, and now: a save that runs late reads both.
  const openedIn = useRef<CellUnit>();
  const shownIn = useRef(display);
  shownIn.current = display;
  // The focus comes back to this cell when another device's switch closes
  // the editor that had it.
  const refocusRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Pointers down while the editor is open (as useSaveOnLeave tracks them),
  // and a click-away save that came due during a press: its click has not
  // run yet, so the save waits for the release, at most a second (a release
  // can be lost), and never past the page going away (adversary R5). Its own
  // submit then checks the unit. A press on a unit control that governs this
  // editor never gets that far: the press closes it (`leaveForUnit`).
  const pointersDown = useRef(new Set<number>());
  const leaveForUnitRef = useRef<() => void>();
  const afterRelease = useRef<(() => void) | null>(null);
  const editing = typed !== null;
  // The editor opens and closes, unmounted or not, through the matrix's
  // callbacks, each called once (US-05 AC3 counts the open Lp(a) editors).
  useEffect(() => {
    if (!editing) return;
    onActivate?.();
    const down = pointersDown.current;
    down.clear();
    // The save waiting for a release: a task on, or now.
    const runWaiting = (later: boolean) => {
      const save = afterRelease.current;
      if (!save) return;
      clearBlurTimer();
      if (later) blurTimerRef.current = window.setTimeout(save, 0);
      else save();
    };
    const onDown = (e: PointerEvent) => {
      if (governs(e.target)) leaveForUnitRef.current?.();
      else down.add(e.pointerId);
    };
    const onUp = (e: PointerEvent) => {
      down.delete(e.pointerId);
      if (down.size === 0) runWaiting(true); // the click, and any switch it made, run first
    };
    const onHide = () => { if (document.visibilityState === 'hidden') runWaiting(false); };
    const onPageHide = () => runWaiting(false);
    const listeners = [['pointerdown', onDown], ['pointerup', onUp], ['pointercancel', onUp]] as const;
    for (const [type, listener] of listeners) document.addEventListener(type, listener, true);
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      for (const [type, listener] of listeners) document.removeEventListener(type, listener, true);
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onPageHide);
      onDeactivate?.();
    };
  }, [editing]);
  // Whether `target` is in this row's own unit control.
  const ownUnitControl = (target: EventTarget | null) => {
    const control = target instanceof Element ? target.closest('[data-unit-control]') : null;
    return !!control && !!inputRef.current?.closest('.bt-row')?.contains(control);
  };
  // Whether `target` is in a unit control that can change this editor's
  // unit: its row's own, or the page's (`data-unit-control="all"`), which
  // changes every core metric's but never a lab value's.
  const governs = (target: EventTarget | null) => ownUnitControl(target)
    || (!!metric && target instanceof Element && !!target.closest('[data-unit-control="all"]'));

  const clearBlurTimer = () => {
    afterRelease.current = null;
    if (blurTimerRef.current != null) {
      window.clearTimeout(blurTimerRef.current);
      blurTimerRef.current = null;
    }
  };
  useEffect(() => clearBlurTimer, []); // also fires on unmount

  const core = metric && display ? { metric, display } : null;
  const initialDisplay = core ? cellText(core.metric, value, core.display) : formatLabValue(value);
  const canCorrect = !!(rowId && onCorrect);

  const beginEdit = () => {
    if (!canCorrect || saving) return;
    // Cancel any pending blur-cancel from a previous cell — otherwise it
    // would fire after this cell mounts and clobber our active state.
    clearBlurTimer();
    setSaveError(null);
    openedOn.current = rowId;
    openedIn.current = display;
    setTyped(initialDisplay);
  };

  const cancel = () => {
    clearBlurTimer();
    setTyped(null);
    setSaveError(null);
  };
  // Leaving for a unit control that governs this editor (US-05 AC2, US-04
  // AC1): the number typed is in a unit the user is about to change, so the
  // editor closes unsaved and says so, at the press, before any click can
  // switch the unit; a save's wait for the release once ran past a held
  // press (adversary R1, 2026-10-13). An editor nobody typed in loses
  // nothing: it closes silently.
  const leaveForUnit = () => {
    if (saving) return;
    cancel();
    openedOn.current = undefined; // a late blur's save, from a handler of the render before, has no row

    if (typed !== initialDisplay) setSaveError(UNIT_FIRST);
  };
  leaveForUnitRef.current = leaveForUnit;
  // A unit switch while the editor is open never saves the typed text
  // (US-05 AC2, US-04 AC1): a user who types 40 and then clicks mg/dL
  // means "this number is in mg/dL", and saving 40 in the old unit is the
  // falsely reassuring error. It closes the editor, as Escape does, clears
  // any click-away save, waiting or not, and says so; a save already
  // running (Enter) reports its own result. The focus stays where the
  // browser put it, except that it comes back to the cell from an editor
  // that had it (another device's switch).
  // Re-expressing the text in the new unit rounded twice: a saved 124.4 shown
  // "49.8" mg/dL came back "125" nmol/L and saved 125. A layout effect, so no
  // keystroke or timer reads the text in the new unit first.
  useLayoutEffect(() => {
    if (typed === null) return;
    const hadFocus = document.activeElement === inputRef.current;
    cancel();
    if (saving) return;
    setSaveError(UNIT_CHANGED);
    refocusRef.current = hadFocus;
  }, [display]);
  // Each message is said in the matrix's live region too.
  useEffect(() => { if (saveError) say?.(saveError); }, [saveError]);

  // Text the editor cannot save: outside the metric's range, or no number.
  const unusable = (text: string) => core
    ? !!validateTypedValue(core.metric, text, core.display).error
    : parseLocalisedNumber(text) === undefined;

  const submit = async () => {
    const opened = openedOn.current;
    if (!opened || !onCorrect || typed === null) return;
    // The unit changed since the editor opened: the text is in the old one.
    if (shownIn.current !== openedIn.current) { cancel(); setSaveError(UNIT_CHANGED); return; }
    // An emptied editor is a change of mind: it closes and writes nothing.
    if (typed.trim() === '') { cancel(); return; }
    if (unusable(typed)) return;
    const parsed = (core ? readTypedValue(core.metric, typed, core.display) : parseLocalisedNumber(typed))!;
    const newValue = core ? cellToSI(core.metric, parsed, core.display) : parsed;
    if (sameAsSaved(parsed, initialDisplay, newValue, value)) { cancel(); return; }
    setSaving(true);
    setSaveError(null);
    const status = await onCorrect(opened, newValue);
    setSaving(false);
    // A value replaced meanwhile closes the editor, and the cell says the
    // edit went; any other failure keeps it open for a retry.
    if (status === 'ok' || status === 'changed') cancel();
    if (status !== 'ok') setSaveError(SAVE_ERRORS[status]);
  };

  if (typed !== null) {
    return (
      <NumericInputCell
        metric={core?.metric}
        display={core?.display}
        grading={grading}
        value={typed}
        onChange={v => { setSaveError(null); setTyped(v); }}
        externalError={saveError}
        wrapperClass={`bt-cell-input bt-cell-correcting${pinned ? ' bt-cell-pinned' : ''}`}
        active
        autoFocus
        disabled={saving}
        inputRef={inputRef}
        onKeyDown={e => {
          blockBadNumericKeys(e);
          if (e.key === 'Enter') { e.preventDefault(); void submit(); }
          if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        }}
        onBlur={e => {
          // The focus going to this row's own unit control (Tab): never arm
          // the save. A press closed the editor already.
          if (ownUnitControl(e.relatedTarget)) return leaveForUnit();
          // Save on click-away when the typed value passes validation —
          // matches the Enter key. If the value is invalid we revert
          // rather than leaving a half-open form with no focus.
          // 150ms defer lets clicks on adjacent affordances intercept.
          const leave = () => {
            if (saving || typed === null) return;
            if (unusable(typed)) cancel();
            else void submit();
          };
          // Due while a pointer is down, the save waits for its release, a
          // second at most.
          blurTimerRef.current = window.setTimeout(() => {
            blurTimerRef.current = null;
            if (pointersDown.current.size === 0) return leave();
            afterRelease.current = leave;
            blurTimerRef.current = window.setTimeout(() => {
              afterRelease.current = null;
              leave();
            }, 1000);
          }, 150);
        }}
      />
    );
  }

  const shown = (
    <>
      <span className="bt-value-num num">
        {initialDisplay}
        {unit && <span className="alr-cell-unit">{unit}</span>}
      </span>
      {saveError
        ? <span className="bt-input-error-text">{saveError}</span>
        : <span className={`bt-status-tick bt-status-${status ?? 'none'}`}/>}
    </>
  );

  if (!canCorrect) {
    return <div className={`bt-cell-value${pinned ? ' bt-cell-pinned' : ''}`}>{shown}</div>;
  }

  return (
    <button
      type="button"
      ref={el => {
        if (el && refocusRef.current) { refocusRef.current = false; el.focus(); }
      }}
      className={`bt-cell-value bt-cell-clickable${pinned ? ' bt-cell-pinned' : ''}`}
      onClick={beginEdit}
      title="Click to correct this value"
    >
      {shown}
    </button>
  );
}

interface DraftCellProps {
  metric: MetricType;
  display: CellUnit;
  grading: Grading;
  value: string;
  /** What the cell saves, graded instead of its shown text (an Lp(a) cell
   *  typed in another unit, US-05 AC2). */
  valueSI?: number;
  /** Why the typed value cannot be saved as it stands (`SAME_SLOT`). */
  error?: string | null;
  active: boolean;
  onFocus: () => void;
  onBlur: () => void;
  onEnter: () => void;
  onChange: (v: string) => void;
}

function DraftCell({ metric, display, grading, value, valueSI, error, active, onFocus, onBlur, onEnter, onChange }: DraftCellProps) {
  return (
    <NumericInputCell
      metric={metric}
      display={display}
      grading={grading}
      value={value}
      valueSI={valueSI}
      externalError={error}
      onChange={onChange}
      wrapperClass="bt-cell-input bt-cell-draft"
      active={active}
      placeholder="—"
      onFocus={onFocus}
      onBlur={onBlur}
      onKeyDown={e => {
        blockBadNumericKeys(e);
        if (e.key === 'Enter') { e.preventDefault(); onEnter(); }
      }}
    />
  );
}

interface BackfillCellProps {
  metric: MetricType;
  display: CellUnit;
  value: string;
  /** Why the typed value cannot be saved as it stands (`SAME_SLOT`). */
  error?: string | null;
  /** The typed text's own check when it was typed in another unit (see
   *  NumericInputCell); omit to check the shown text. */
  validationResult?: string | null;
  active: boolean;
  onFocus: () => void;
  onBlur: () => void;
  onEnter: () => void;
  onChange: (v: string) => void;
  /** Appends `bt-cell-pinned` (the 2nd-from-right column highlight). The
   *  blood-test matrix never pins a backfill cell; the vitals matrix does. */
  pinned?: boolean;
}

// Exported so StartingInfoVitals reuses the identical empty-slot input cell
// (one source of truth for backfill styling + key handling across both matrices).
export function BackfillCell({ metric, display, value, error, validationResult, active, onFocus, onBlur, onEnter, onChange, pinned }: BackfillCellProps) {
  return (
    <NumericInputCell
      metric={metric}
      display={display}
      value={value}
      externalError={error}
      validationResult={validationResult}
      onChange={onChange}
      wrapperClass={`bt-cell-backfill${pinned ? ' bt-cell-pinned' : ''}`}
      inputClass="bt-input bt-input-backfill"
      active={active}
      placeholder="—"
      onFocus={onFocus}
      onBlur={onBlur}
      onKeyDown={e => {
        blockBadNumericKeys(e);
        if (e.key === 'Enter') { e.preventDefault(); onEnter(); }
      }}
    />
  );
}
