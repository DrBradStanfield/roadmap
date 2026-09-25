// V2 timeline-matrix UI for the blood-test section.
// Rows = metrics; columns = older batches → 2 most recent → draft column.
// Values stored in SI canonical throughout; inputs converted on commit.

import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import {
  type ApiMeasurement,
  type UnitSystem,
  type MetricType,
  type HealthInputs,
  toCanonicalValue,
  fromCanonicalValue,
  formatDisplayValue,
  getDisplayLabel,
  BLOOD_TEST_METRICS,
  METRIC_TO_FIELD,
  METRIC_LABELS,
  refHintFor,
  parseLocalisedNumber,
} from '@roadmap/health-core';
import { MONTHS_SHORT } from '../lib/constants';
import { BT_TIMELINE_DRAFT_KEY } from '../lib/storage';
import { useDraftMirror, useMatrixDraft } from '../lib/useMatrixDraft';
import { useSaveOnLeave } from '../lib/useSaveOnLeave';
import { useScrollToRightOnMount } from '../lib/useScrollToRightOnMount';
import { usePrefillRef } from '../lib/usePrefillRef';
import { slotOf, type CorrectFn, type Refused, type SaveTask } from '../lib/matrix-save';
import type { CorrectStatus } from '../storage/roadmap-store';
import {
  type Status,
  blockBadNumericKeys,
  formatLabValue,
  sameAsSaved,
  validateTypedValue,
  statusOf,
} from '../lib/blood-test-cell';
import { NumericInputCell } from './NumericInputCell';
import { CommitTickButton } from './CommitTickButton';
import { DraftDateCell } from './DraftDateCell';
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
  onDraftValue: (field: keyof HealthInputs, siValue: number | undefined) => void;
  isSaving: boolean;
  sex?: 'male' | 'female';
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

const MONTH_LABELS = MONTHS_SHORT.map(m => m.label);

export function BloodTestTimeline({
  bloodTestHistory, unitSystem, unitOverrides, onToggleFieldUnit,
  onSaveBatch, onCorrectValue, onDraftValue, isSaving, sex, onUploadClick, uploadDisabled, loginUrl,
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
    draft, backfills, type, setDate: setDraftDate, expected, clashes, taken, lends, settle, refusal,
  } = useMatrixDraft<MetricType>(BT_TIMELINE_DRAFT_KEY, { onScreen, rowsUnder, latestDay });
  const [activeCell, setActiveCell] = useState<string | null>(null);

  const fieldUnit = (field: string): UnitSystem => unitOverrides[field] ?? unitSystem;

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
      const unit = fieldUnit(field);
      const blocked = !!validateTypedValue(metric, typed, unit).error || ((column ?? draft.date) === draft.date && clashes(metric));
      return [{ column, date: column ?? draft.date, metric, unit, si: blocked ? null : toCanonicalValue(metric, parseLocalisedNumber(typed)!, unit) }];
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
  // value the test can take, clear of clashes (`si`).
  useDraftMirror(ROWS.map(({ metric, field }) => [
    field,
    lends(metric) ? cells.find(c => c.column === null && c.metric === metric)?.si ?? undefined : undefined,
  ]), onDraftValue);

  const setDraftValue = (metric: MetricType, typed: string) => type([null, metric], typed);
  const setBackfillValue = (batchDate: string, metric: MetricType, typed: string) => type([batchDate, metric], typed);

  // Inject an external value (from the chatbot) into the matrix. Converts the
  // value from its stated unit into THIS cell's display unit, formats it, and
  // routes it to the matching existing batch (backfill) or the draft column.
  // Returns the cell key so the parent can scroll/highlight it.
  const prefillCell: BloodTestPrefillFn = (metric, value, fromUnit, date) => {
    const row = ROWS.find(r => r.metric === metric);
    if (!row) return null; // e.g. PSA — not in this matrix
    const cellUnit = fieldUnit(row.field);
    // Re-express the value in the cell's display unit (chat sends the user's
    // stated unit; the cell may be showing the other system).
    const si = toCanonicalValue(metric, value, fromUnit);
    const typed = formatDisplayValue(metric, si, cellUnit);

    // Use the backfill column only when an existing batch on that date has an
    // EMPTY cell for this metric. If a value already exists there, route to the
    // draft column instead (the user reviews + Saves; a real correction goes
    // through the click-to-edit ValueCell path, not chat pre-fill).
    const existingBatch = date ? batches.find(b => b.date === date) : undefined;
    if (date && existingBatch && existingBatch.values[metric] == null) {
      setBackfillValue(date, metric, typed);
      const cellId = `${date}.${metric}`;
      setActiveCell(cellId);
      return cellId;
    }
    if (date) setDraftDate(date);
    setDraftValue(metric, typed); // the plan and the chat read it while it may stand in
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
        <h3 className="bt-timeline-title">Blood Test Results</h3>
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
            const unitLabel = getDisplayLabel(row.metric, display);

            // Sparkline points in display units. Series is precomputed in SI;
            // converting to display unit here keeps the y-axis monotonic when
            // the user toggles SI ↔ conventional.
            const sparkPoints = (series[row.metric] ?? [])
              .map(siVal => fromCanonicalValue(row.metric, siVal, display));
            const last = lastSi[row.metric];
            const lastStatus = last != null ? statusOf(row.metric, last, sex) : null;

            return (
              <div key={row.field} className={`bt-row${rowIdx === ROWS.length - 1 ? ' bt-row-last' : ''}`}>
                <div className="bt-cell-name">
                  <div className="bt-name-label">{row.label}</div>
                  <UnitChip label={unitLabel} onToggle={() => onToggleFieldUnit(row.field)}/>
                  {(() => {
                    const ref = refHintFor(row.metric, display, sex);
                    return ref ? <div className="bt-ref-label">{ref}</div> : null;
                  })()}
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
                        sex={sex}
                        value={typed}
                        error={clashes(row.metric) || taken(row.metric) ? SAME_SLOT : refusal([null, row.metric])}
                        active={activeCell === cellId}
                        onFocus={() => setActiveCell(cellId)}
                        onBlur={() => setActiveCell(null)}
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
                        value={typed}
                        error={c.date === draft.date && clashes(row.metric) ? SAME_SLOT : refusal([c.date, row.metric])}
                        active={activeCell === cellId}
                        onFocus={() => setActiveCell(cellId)}
                        onBlur={() => setActiveCell(null)}
                        onEnter={saveNow}
                        onChange={v => setBackfillValue(c.date, row.metric, v)}
                      />
                    );
                  }
                  const status = statusOf(row.metric, v, sex);
                  const isPinned = colIdx === columns.length - 2;
                  const cellId = `${c.date}.${row.metric}`;
                  // c.kind === 'batch' here — the 'draft' branch returned above
                  const rowId = c.kind === 'batch' ? c.ids[row.metric] : undefined;
                  return (
                    <ValueCell
                      key={cellId}
                      metric={row.metric}
                      display={display}
                      sex={sex}
                      value={v}
                      rowId={rowId}
                      status={status}
                      pinned={isPinned}
                      onActivate={() => setActiveCell(cellId)}
                      onDeactivate={() => setActiveCell(null)}
                      onCorrect={onCorrectValue}
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
    </div>
  );
}

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
  display?: UnitSystem;
  sex?: 'male' | 'female';
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
}

/** What a matrix says when a save did not all land (US-03 AC4). */
export const SAVE_FAILED = 'Some values did not save. Try again.';

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
  metric, display, sex, value, unit, rowId, status, pinned, onActivate, onDeactivate, onCorrect,
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

  const clearBlurTimer = () => {
    if (blurTimerRef.current != null) {
      window.clearTimeout(blurTimerRef.current);
      blurTimerRef.current = null;
    }
  };
  useEffect(() => clearBlurTimer, []); // also fires on unmount

  const core = metric && display ? { metric, display } : null;
  const initialDisplay = core ? formatDisplayValue(core.metric, value, core.display) : formatLabValue(value);
  const canCorrect = !!(rowId && onCorrect);

  const beginEdit = () => {
    if (!canCorrect) return;
    // Cancel any pending blur-cancel from a previous cell — otherwise it
    // would fire after this cell mounts and clobber our active state.
    clearBlurTimer();
    setSaveError(null);
    openedOn.current = rowId;
    setTyped(initialDisplay);
    onActivate?.();
  };

  const cancel = () => {
    clearBlurTimer();
    setTyped(null);
    setSaveError(null);
    onDeactivate?.();
  };

  // Text the editor cannot save: outside the metric's range, or no number.
  const unusable = (text: string) => core
    ? !!validateTypedValue(core.metric, text, core.display).error
    : parseLocalisedNumber(text) === undefined;

  const submit = async () => {
    const opened = openedOn.current;
    if (!opened || !onCorrect || typed === null) return;
    // An emptied editor is a change of mind: it closes and writes nothing.
    if (typed.trim() === '') { cancel(); return; }
    if (unusable(typed)) return;
    const parsed = parseLocalisedNumber(typed)!;
    const newValue = core ? toCanonicalValue(core.metric, parsed, core.display) : parsed;
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
        sex={sex}
        value={typed}
        onChange={v => { setSaveError(null); setTyped(v); }}
        externalError={saveError}
        wrapperClass={`bt-cell-input bt-cell-correcting${pinned ? ' bt-cell-pinned' : ''}`}
        active
        autoFocus
        disabled={saving}
        onKeyDown={e => {
          blockBadNumericKeys(e);
          if (e.key === 'Enter') { e.preventDefault(); void submit(); }
          if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        }}
        onBlur={() => {
          // Save on click-away when the typed value passes validation —
          // matches the Enter key. If the value is invalid we revert
          // rather than leaving a half-open form with no focus.
          // 150ms defer lets clicks on adjacent affordances intercept.
          blurTimerRef.current = window.setTimeout(() => {
            if (saving || typed === null) return;
            if (unusable(typed)) cancel();
            else void submit();
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
  display: UnitSystem;
  sex?: 'male' | 'female';
  value: string;
  /** Why the typed value cannot be saved as it stands (`SAME_SLOT`). */
  error?: string | null;
  active: boolean;
  onFocus: () => void;
  onBlur: () => void;
  onEnter: () => void;
  onChange: (v: string) => void;
}

function DraftCell({ metric, display, sex, value, error, active, onFocus, onBlur, onEnter, onChange }: DraftCellProps) {
  return (
    <NumericInputCell
      metric={metric}
      display={display}
      sex={sex}
      value={value}
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
  display: UnitSystem;
  value: string;
  /** Why the typed value cannot be saved as it stands (`SAME_SLOT`). */
  error?: string | null;
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
export function BackfillCell({ metric, display, value, error, active, onFocus, onBlur, onEnter, onChange, pinned }: BackfillCellProps) {
  return (
    <NumericInputCell
      metric={metric}
      display={display}
      value={value}
      externalError={error}
      onChange={onChange}
      wrapperClass={`bt-cell-backfill${pinned ? ' bt-cell-pinned' : ''}`}
      inputClass="bt-input bt-input-backfill"
      active={active}
      placeholder="—"
      showStatusPreview={false}
      onFocus={onFocus}
      onBlur={onBlur}
      onKeyDown={e => {
        blockBadNumericKeys(e);
        if (e.key === 'Enter') { e.preventDefault(); onEnter(); }
      }}
    />
  );
}
