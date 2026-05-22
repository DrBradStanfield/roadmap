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
import { safeGetItem, safeSetItem, safeRemoveItem } from '../lib/storage';
import { useDebouncedSave } from '../lib/useDebouncedSave';
import { useScrollToRightOnMount } from '../lib/useScrollToRightOnMount';
import {
  type Status,
  blockBadNumericKeys,
  validateTypedValue,
  statusOf,
} from '../lib/blood-test-cell';
import { NumericInputCell } from './NumericInputCell';
import { CommitTickButton } from './CommitTickButton';
import { DraftDateCell } from './DraftDateCell';
import { UnitChip } from './UnitChip';

// localStorage key for the matrix's typed-but-unsaved state. Persists across
// page reloads so users don't lose work mid-edit. Cleared on successful Save.
const DRAFT_STORAGE_KEY = 'health_roadmap_bt_timeline_draft';

interface PersistedDraft {
  draft: { date: string; values: Record<string, string> };
  backfills: Record<string, Record<string, string>>;
}

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
  // Guests have no cloud account; typed values persist via localStorage
  // (draft state + inputs mirror saved by HealthTool's guest debounce). The
  // matrix skips its save→clear cycle in that case to avoid wiping the user's
  // typed values when the cloud save no-ops.
  isLoggedIn: boolean;
  onSaveBatch: (date: string, values: Record<string, number>) => Promise<void>;
  // ValueCell calls this when the user submits an in-place correction.
  // Resolves true if the parent successfully refreshed; false leaves the
  // edit form open so the user can retry.
  onCorrectValue?: (oldId: string, newValueSI: number) => Promise<{ ok: true } | { ok: false; reason: 'conflict' | 'not_found' | 'error' }>;
  // Called on every typed-value change so the suggestions engine (which reads
  // from `inputs[field]`) sees draft values live. Pass siValue = undefined
  // to clear the field (empty input or out-of-range).
  onFieldChange: (field: keyof HealthInputs, siValue: number | undefined) => void;
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
}

interface DraftRow {
  date: string;
  // Typed values, keyed by MetricType, in display unit (NOT SI).
  values: Partial<Record<MetricType, string>>;
}

interface BackfillMap {
  // batchDate → metric → typed value (in display unit).
  [batchDate: string]: Partial<Record<MetricType, string>>;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function emptyDraft(): DraftRow {
  return { date: todayIso(), values: {} };
}

function loadPersisted(): { draft: DraftRow; backfills: BackfillMap } | null {
  const raw = safeGetItem(DRAFT_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PersistedDraft;
    if (!parsed || typeof parsed !== 'object') return null;
    const draftDate = typeof parsed.draft?.date === 'string' && parsed.draft.date
      ? parsed.draft.date : todayIso();
    const draftValues = (parsed.draft && typeof parsed.draft.values === 'object' && parsed.draft.values)
      ? (parsed.draft.values as Partial<Record<MetricType, string>>) : {};
    const backfills = (parsed.backfills && typeof parsed.backfills === 'object')
      ? (parsed.backfills as BackfillMap) : {};
    return { draft: { date: draftDate, values: draftValues }, backfills };
  } catch { return null; }
}

const MONTH_LABELS = MONTHS_SHORT.map(m => m.label);

export function BloodTestTimeline({
  bloodTestHistory, unitSystem, unitOverrides, onToggleFieldUnit, isLoggedIn,
  onSaveBatch, onCorrectValue, onFieldChange, isSaving, sex, onUploadClick, uploadDisabled, loginUrl,
  hasApiResponse, flushRef,
}: BloodTestTimelineProps) {
  const batches = useMemo(() => groupByBatch(bloodTestHistory), [bloodTestHistory]);
  // Restore draft + backfills from localStorage on mount so typed-but-unsaved
  // values survive page reloads. The mirrored `inputs[field]` SI value comes
  // back via the legacy load path, but loses the user's typed display-unit
  // text (e.g. `4.5` vs `4.50`); persisting here preserves the typed UX.
  const [draft, setDraft] = useState<DraftRow>(() => loadPersisted()?.draft ?? emptyDraft());
  const [backfills, setBackfills] = useState<BackfillMap>(() => loadPersisted()?.backfills ?? {});
  const [activeCell, setActiveCell] = useState<string | null>(null);

  // Persist draft + backfills on every change so reloads don't lose typed
  // values. Empty state ⇒ remove the key (no stray storage). activeCell is
  // intentionally NOT persisted (UI-only state, fine to lose on reload).
  useEffect(() => {
    const isEmpty =
      Object.keys(draft.values).length === 0 && Object.keys(backfills).length === 0;
    if (isEmpty) {
      safeRemoveItem(DRAFT_STORAGE_KEY);
      return;
    }
    const payload: PersistedDraft = {
      draft: { date: draft.date, values: draft.values as Record<string, string> },
      backfills: backfills as Record<string, Record<string, string>>,
    };
    safeSetItem(DRAFT_STORAGE_KEY, JSON.stringify(payload));
  }, [draft, backfills]);

  // After a successful Save, clear stored draft state explicitly. setDraft +
  // setBackfills already reset, and the persist effect above will see empty
  // state and remove the key — but call removeItem here too for safety in case
  // the effect is somehow batched away.

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

  // Count of filled draft + backfill cells, and any validation error blocks Save.
  const { filledCount, hasError } = useMemo(() => {
    let n = 0;
    let err = false;
    const check = (m: MetricType, typed: string | undefined, fld: keyof HealthInputs) => {
      if (typed == null || typed === '') return;
      n++;
      const display = unitOverrides[fld] ?? unitSystem;
      const v = validateTypedValue(m, typed, display);
      if (v.error) err = true;
    };
    for (const r of ROWS) check(r.metric, draft.values[r.metric], r.field);
    for (const dateMap of Object.values(backfills)) {
      for (const r of ROWS) check(r.metric, dateMap[r.metric], r.field);
    }
    return { filledCount: n, hasError: err };
  }, [draft.values, backfills, unitOverrides, unitSystem]);

  // Single scroll container for the whole matrix. Native horizontal scroll
  // moves all rows in lockstep — sticky name + trend cells stay in place.
  // Draft column visible by default (matrix scrolls to its rightmost edge
  // on first mount).
  const scrollRef = useScrollToRightOnMount<HTMLDivElement>([columns.length]);

  const setDraftValue = (metric: MetricType, typed: string) => {
    setDraft(d => ({ ...d, values: { ...d.values, [metric]: typed } }));
    // Mirror to inputs[field] in SI so the suggestions engine sees the draft
    // value live. Pass undefined when empty or out-of-range so suggestions
    // don't fire on bogus values.
    const row = ROWS.find(r => r.metric === metric);
    if (!row) return;
    const display = unitOverrides[row.field] ?? unitSystem;
    const { error } = validateTypedValue(metric, typed, display);
    if (typed === '' || error) {
      onFieldChange(row.field, undefined);
    } else {
      const n = parseLocalisedNumber(typed);
      if (n !== undefined) onFieldChange(row.field, toCanonicalValue(metric, n, display));
    }
  };

  const setDraftDate = (date: string) =>
    setDraft(d => ({ ...d, date }));

  const setBackfillValue = (batchDate: string, metric: MetricType, typed: string) =>
    setBackfills(prev => {
      const next = { ...prev };
      const row = { ...(next[batchDate] || {}) };
      if (typed === '') {
        delete (row as Record<string, string>)[metric];
        if (Object.keys(row).length === 0) delete next[batchDate];
        else next[batchDate] = row;
      } else {
        (row as Record<string, string>)[metric] = typed;
        next[batchDate] = row;
      }
      return next;
    });

  // Convert display-unit typed values to SI using the metric's display unit.
  const toSiMap = (typedMap: Partial<Record<MetricType, string>>): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const row of ROWS) {
      const typed = typedMap[row.metric];
      if (typed == null || typed === '') continue;
      const n = parseLocalisedNumber(typed);
      if (n === undefined) continue;
      const display = fieldUnit(row.field);
      out[row.metric] = toCanonicalValue(row.metric, n, display);
    }
    return out;
  };

  const saveDisabledByLoad = hasApiResponse === false;

  const handleSave = async () => {
    if (filledCount === 0 || isSaving || hasError || saveDisabledByLoad) return;
    // Guests have no remote save target — onSaveBatch resolves as a no-op via
    // handleSaveLongitudinal's `!authState.isLoggedIn` early return. Without
    // this guard we'd then clear draft + inputs mirror, wiping the user's
    // typed values from both the matrix and localStorage.
    if (!isLoggedIn) return;

    // Commit each affected batch (backfill date or draft date) sequentially.
    // Concurrent calls would be short-circuited by handleSaveLongitudinal's
    // re-entry guard (isSavingLongitudinalRef) in HealthTool. Backfills first,
    // draft last so the newest entry ends up at the right of the matrix.
    const tasks: Array<{ date: string; values: Record<string, number> }> = [];
    for (const [batchDate, typedMap] of Object.entries(backfills)) {
      const siValues = toSiMap(typedMap);
      if (Object.keys(siValues).length > 0) tasks.push({ date: batchDate, values: siValues });
    }
    const draftSi = toSiMap(draft.values);
    if (Object.keys(draftSi).length > 0) tasks.push({ date: draft.date, values: draftSi });

    // Same-(date, metric) rows route through correctMeasurement to honour FHIR
    // (replaces semantic + entered-in-error on old row), avoiding the silent
    // 409-cleared-draft that the partial unique index would otherwise produce.
    // Index history once instead of `bloodTestHistory.find(...)` per metric
    // per task: O(N+M) over O(N×M).
    const activeRowByDateMetric = new Map<string, ApiMeasurement>();
    for (const m of bloodTestHistory) {
      if ((m.status ?? 'active') !== 'active') continue;
      const key = `${m.recordedAt.slice(0, 10)}|${m.metricType}`;
      if (!activeRowByDateMetric.has(key)) activeRowByDateMetric.set(key, m);
    }

    let anySaveFailed = false;
    for (const t of tasks) {
      const corrections: Array<{ id: string; value: number }> = [];
      const newInserts: Record<string, number> = {};
      for (const [metric, value] of Object.entries(t.values)) {
        const existing = activeRowByDateMetric.get(`${t.date}|${metric}`);
        if (existing && onCorrectValue) {
          corrections.push({ id: existing.id, value });
        } else {
          newInserts[metric] = value;
        }
      }
      if (corrections.length > 0 && onCorrectValue) {
        const results = await Promise.all(corrections.map(c => onCorrectValue(c.id, c.value)));
        if (results.some(r => !r.ok)) anySaveFailed = true;
      }
      if (Object.keys(newInserts).length > 0) {
        await onSaveBatch(t.date, newInserts);
      }
    }

    // Preserve the user's typed draft if any save failed so they can retry
    // (otherwise the matrix clears and the typed value is lost).
    if (anySaveFailed) return;

    // Clear `inputs` mirror for blood-test fields that were saved, so the
    // legacy global "Save New Values" button doesn't pick them up again.
    for (const r of ROWS) {
      if (draft.values[r.metric] !== undefined) onFieldChange(r.field, undefined);
    }
    setDraft(emptyDraft());
    setBackfills({});
    setActiveCell(null);
    safeRemoveItem(DRAFT_STORAGE_KEY);
  };

  // Expose `handleSave` to the parent via flushRef so the upload-modal flow
  // (and any future "save before X" caller) can commit in-flight typed values
  // before its own save runs. Re-assign on every render so the latest closure
  // (with current draft/backfills) is what fires. Cleanup on unmount.
  const handleSaveRef = useRef(handleSave);
  handleSaveRef.current = handleSave;
  useEffect(() => {
    if (!flushRef) return;
    flushRef.current = () => handleSaveRef.current();
    return () => { if (flushRef) flushRef.current = null; };
  }, [flushRef]);

  // Auto-save on blur / Enter for draft + backfill cells. 500ms debounce
  // so tab-between-cells doesn't fire mid-edit; the existing handleSave
  // already batches every dirty cell into one onSaveBatch per date.
  const matrixDebounce = useDebouncedSave(500);
  const scheduleMatrixSave = () => {
    if (filledCount === 0 || isSaving || hasError || saveDisabledByLoad) return;
    matrixDebounce.schedule(() => { void handleSaveRef.current(); });
  };
  const flushMatrixSave = () => {
    if (filledCount === 0 || isSaving || hasError || saveDisabledByLoad) {
      matrixDebounce.cancel();
      return;
    }
    matrixDebounce.commit(() => { void handleSaveRef.current(); });
  };

  return (
    <div className="bt-timeline">
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
          {filledCount > 0 && !isSaving && !hasError && (
            <CommitTickButton variant="matrix" ariaLabel="Save typed values" onClick={flushMatrixSave}/>
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
              if (c.kind === 'draft') return <DraftDateCell key="draft" date={c.date} onChange={setDraftDate} ariaLabel="Choose draft batch date"/>;
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
                        active={activeCell === cellId}
                        onFocus={() => setActiveCell(cellId)}
                        onBlur={() => { setActiveCell(null); scheduleMatrixSave(); }}
                        onEnter={flushMatrixSave}
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
                        active={activeCell === cellId}
                        onFocus={() => setActiveCell(cellId)}
                        onBlur={() => { setActiveCell(null); scheduleMatrixSave(); }}
                        onEnter={flushMatrixSave}
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
                      siValue={v}
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

function BatchDateCell({ date, pinned }: { date: string; pinned: boolean }) {
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
  metric: MetricType;
  display: UnitSystem;
  sex?: 'male' | 'female';
  siValue: number;
  rowId?: string;
  status: Status;
  pinned: boolean;
  onActivate: () => void;
  onDeactivate: () => void;
  onCorrect?: (oldId: string, newValueSI: number) => Promise<{ ok: true } | { ok: false; reason: 'conflict' | 'not_found' | 'error' }>;
}

function ValueCell({
  metric, display, sex, siValue, rowId, status, pinned, onActivate, onDeactivate, onCorrect,
}: ValueCellProps) {
  // `typed === null` ⇒ read-only; otherwise the in-place edit form is open.
  // One field replaces the old (editing, typed) pair — impossible state gone.
  const [typed, setTyped] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const blurTimerRef = useRef<number | null>(null);

  const clearBlurTimer = () => {
    if (blurTimerRef.current != null) {
      window.clearTimeout(blurTimerRef.current);
      blurTimerRef.current = null;
    }
  };
  useEffect(() => clearBlurTimer, []); // also fires on unmount

  const initialDisplay = formatDisplayValue(metric, siValue, display);
  const canCorrect = !!(rowId && onCorrect);

  const beginEdit = () => {
    if (!canCorrect) return;
    // Cancel any pending blur-cancel from a previous cell — otherwise it
    // would fire after this cell mounts and clobber our active state.
    clearBlurTimer();
    setSaveError(null);
    setTyped(initialDisplay);
    onActivate();
  };

  const cancel = () => {
    clearBlurTimer();
    setTyped(null);
    setSaveError(null);
    onDeactivate();
  };

  const submit = async () => {
    if (!canCorrect || !rowId || !onCorrect || typed === null) return;
    const { error } = validateTypedValue(metric, typed, display);
    if (error) return;
    const parsed = parseLocalisedNumber(typed);
    if (parsed === undefined) return;
    if (typed.trim() === initialDisplay.trim()) { cancel(); return; }
    const newSi = toCanonicalValue(metric, parsed, display);
    setSaving(true);
    setSaveError(null);
    const result = await onCorrect(rowId, newSi);
    setSaving(false);
    if (result.ok) {
      cancel();
    } else {
      // Keep the form open so the user can retry. Tailor the message to
      // the failure mode so a transient conflict reads differently from a
      // network drop.
      setSaveError(
        result.reason === 'conflict'
          ? 'Another value was saved at this date. Refresh and try again.'
          : result.reason === 'not_found'
          ? 'This value was deleted or already updated. Refresh to see the latest.'
          : 'Could not save. Check your connection and try again.'
      );
    }
  };

  if (typed !== null) {
    return (
      <NumericInputCell
        metric={metric}
        display={display}
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
            const { error } = validateTypedValue(metric, typed, display);
            if (error) cancel();
            else void submit();
          }, 150);
        }}
      />
    );
  }

  if (!canCorrect) {
    return (
      <div className={`bt-cell-value${pinned ? ' bt-cell-pinned' : ''}`}>
        <span className="bt-value-num num">{initialDisplay}</span>
        <span className={`bt-status-tick bt-status-${status ?? 'none'}`}/>
      </div>
    );
  }

  return (
    <button
      type="button"
      className={`bt-cell-value bt-cell-clickable${pinned ? ' bt-cell-pinned' : ''}`}
      onClick={beginEdit}
      title="Click to correct this value"
    >
      <span className="bt-value-num num">{initialDisplay}</span>
      <span className={`bt-status-tick bt-status-${status ?? 'none'}`}/>
    </button>
  );
}

interface DraftCellProps {
  metric: MetricType;
  display: UnitSystem;
  sex?: 'male' | 'female';
  value: string;
  active: boolean;
  onFocus: () => void;
  onBlur: () => void;
  onEnter: () => void;
  onChange: (v: string) => void;
}

function DraftCell({ metric, display, sex, value, active, onFocus, onBlur, onEnter, onChange }: DraftCellProps) {
  return (
    <NumericInputCell
      metric={metric}
      display={display}
      sex={sex}
      value={value}
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
  active: boolean;
  onFocus: () => void;
  onBlur: () => void;
  onEnter: () => void;
  onChange: (v: string) => void;
}

function BackfillCell({ metric, display, value, active, onFocus, onBlur, onEnter, onChange }: BackfillCellProps) {
  return (
    <NumericInputCell
      metric={metric}
      display={display}
      value={value}
      onChange={onChange}
      wrapperClass="bt-cell-backfill"
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
