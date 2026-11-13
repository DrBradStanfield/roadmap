// Vitals (Weight, Waist, Blood Pressure) rendered through the SAME unified
// column-grid layout as BloodTestTimeline: one shared card, one date-header
// row, metrics as rows, dates as columns aligned across every row, a single
// horizontal scroll, and a Trend column on the right. Brad's ask was that on
// refresh the vitals table "match the layout of the blood test table" — so
// this mirrors BloodTestTimeline's structure (`.bt-timeline-scroll` single
// scroller + `--bt-col-count` pixel-width inner) rather than the old
// per-metric independent strips.
//
// Columns are the UNION of every distinct date across weight / waist / BP
// (sys+dia share a date) — sparse cells render an empty backfill input, just
// like the blood-test matrix. A shared draft column on the right lets the user
// add a new reading for any vital at one date.
//
// Status thresholds (IBW for weight, WHtR < 0.5 for waist, BP < 120/80) depend
// on the plan; they live in health-core (row-grade.ts) beside `statusOf`, so
// the iPhone grades by the same lines. Everything else reuses the `.bt-*` CSS,
// the matrix's `Sparkline`, `NumericInputCell`, `DraftDateCell`, and `UnitChip`.

import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import type { ApiMeasurement, FormStage } from '@roadmap/health-core/mappings';
import type { HealthInputs } from '@roadmap/health-core/types';
import { type MetricType, type UnitSystem, toCanonicalValue, fromCanonicalValue, formatDisplayValue, getDisplayLabel, bpTargetFor } from '@roadmap/health-core/units';
import { parseLocalisedNumber } from '@roadmap/health-core/parseNumber';
import { bpStatus, limitUngraded, pressureStatus, valueStatus, type GradeContext, type PressureReading } from '@roadmap/health-core/row-grade';
import { limitText, LIMIT_NOT_GRADED, type Comparator } from '@roadmap/health-core/lab-limits';
import { rowTarget } from '@roadmap/health-core/row-target';
import type { PlanBasis } from './InputPanel';
import { slotOf, type CorrectFn, type Refused, type SaveTask } from '../lib/matrix-save';
import {
  blockBadNumericKeys,
  readTypedValue,
  validateTypedValue,
} from '../lib/blood-test-cell';
import { VITALS_DRAFT_KEY } from '../lib/storage';
import { FIELD_OF, vitalsCellsOf, type VitalsKey } from '../lib/vitals-cells';
import { buildColumns, type DateColumn } from '../lib/vitals-columns';
import { useMatrixDraft, type CellRef } from '../lib/useMatrixDraft';
import { useAutoAdvance } from '../lib/useAutoAdvance';
import { useScrollToRightOnMount } from '../lib/useScrollToRightOnMount';
import { useSaveOnLeave } from '../lib/useSaveOnLeave';
import { usePrefillRef } from '../lib/usePrefillRef';
import { Sparkline, ValueCell, BatchDateCell, saveErrorText, SAVE_FAILED, SAME_SLOT, useLiveRegion } from './BloodTestTimeline';
import { BackfillCell } from './MatrixInputCells';
import { NumericInputCell } from './NumericInputCell';
import { DraftDateCell } from './DraftDateCell';
import { BpInputCell } from './BpInputCell';
import { UnitChip } from './UnitChip';

interface StartingInfoVitalsProps {
  /** Told whether the grid keeps any typed text, valid or not (US-62 AC11). */
  onHoldsText?: (holds: boolean) => void;
  /** Full per-metric history (filtered to vitals metrics). Latest-per-metric
   *  is insufficient — the matrix needs the timeline. */
  vitalsHistory: ApiMeasurement[];
  unitSystem: UnitSystem;
  /** Same handler used by BloodTestTimeline. Sends one task per day (SI
   *  values keyed by metricType, an ISO `yyyy-mm-dd` date) through
   *  `handleSaveLongitudinal`, which routes them; resolves with what was
   *  refused, slot by slot. */
  onSave: (tasks: SaveTask[]) => Promise<Refused>;
  /** Click-to-correct handler for saved single-value cells (weight / waist).
   *  Same prop the blood-test matrix uses. BP cells stay display-only (a
   *  sys/dia cell is ambiguous to correct in place). */
  onCorrectValue?: CorrectFn;
  /** At stage 1 the weight draft cell pulses until it holds a valid weight (US-62 AC13). */
  formStage: FormStage;
  /** What the plan was computed from (US-06 AC5): its age sets the
   *  blood-pressure target, its weight target (kg) the weight line and its
   *  validated height (cm) the waist line. Null until there is a plan. */
  plan: Pick<PlanBasis, 'age' | 'idealBodyWeight' | 'heightCm'> | null;
  /** A known minor, plan or no plan: no adult weight or BP target or colour (US-07 AC6). */
  knownMinor?: boolean;
  /** The weight cell's answer (`neverLands`: a past day's), its ref, and its rest: the landing (US-62 AC25b). */
  onWeightAnswered?: (neverLands?: boolean) => void;
  weightRef?: (el: HTMLInputElement | null) => void;
  rested?: () => void;
  /** The weight is asked beside the height (US-62 AC13): its row is left out, so it shows once. */
  withoutWeight?: boolean;
  /** Per-field unit overrides — clicking the weight/waist chip toggles
   *  just that metric's display unit (kg ↔ lbs, cm ↔ inches). */
  unitOverrides: Record<string, UnitSystem>;
  onToggleFieldUnit: (field: string) => void;
  /** This device's unit for a field before the record's applied (useUnits): a kept cell with no unit was typed in it. */
  startUnitOf?: (field: string) => UnitSystem;
  /** When provided, the matrix exposes an imperative `prefill(metric, value,
   *  fromUnit, date)` so the chatbot can inject a vitals value into the
   *  draft/backfill cell (highlighted, for the user to Save). Mirrors
   *  BloodTestTimeline's prefillRef seam — its presence also signals to the
   *  parent that the vitals matrix is mounted (the whole form shows), so chat
   *  edits should flash a cell here rather than silently set a plain field. */
  prefillRef?: MutableRefObject<VitalsPrefillFn | null>;
  /** Filled with the matrix's commit, so a lab upload commits the draft
   *  before its own save (US-03 AC5). */
  flushRef?: MutableRefObject<(() => Promise<void>) | null>;
}

/** Inject a vitals value into the matrix from outside (e.g. the chatbot).
 *  `value` is in `fromUnit`, and the cell keeps it in that unit, as typed;
 *  it shows in the display unit and is saved exactly (US-03 AC3).
 *  `date` null = today's draft column. BP routes by metric (systolic_bp /
 *  diastolic_bp) into the shared sys/dia cell. Returns the cell key it filled
 *  so the parent can scroll/highlight it (or null for an unhandled metric). */
export type VitalsPrefillFn = (
  metric: MetricType,
  value: number,
  fromUnit: UnitSystem,
  date: string | null,
) => string | null;

// ── Row config ──────────────────────────────────────────────────────────

type SimpleRowConfig = {
  kind: 'simple';
  metric: 'weight' | 'waist';
  field: keyof HealthInputs;
  label: string;
};
type BpRowConfig = { kind: 'bp'; label: string };
type RowConfig = SimpleRowConfig | BpRowConfig;

const ROWS: RowConfig[] = [
  { kind: 'simple', metric: 'weight', field: 'weightKg', label: 'Weight' },
  { kind: 'simple', metric: 'waist', field: 'waistCm', label: 'Waist Circumference' },
  { kind: 'bp', label: 'Blood Pressure' },
];

// ── Component ───────────────────────────────────────────────────────────

export function StartingInfoVitals({
  vitalsHistory, unitSystem, onSave, onCorrectValue,
  formStage, plan, knownMinor, onWeightAnswered, weightRef, rested, withoutWeight, unitOverrides, onToggleFieldUnit, startUnitOf,
  prefillRef, flushRef, onHoldsText,
}: StartingInfoVitalsProps) {
  const rows = withoutWeight ? ROWS.filter(r => r.kind !== 'simple' || r.metric !== 'weight') : ROWS;
  // The plan's systolic target; none, and no BP colours, with no plan. A known
  // minor gets no adult weight or BP target or colour (US-07 AC6); the waist
  // line, half the height, is also used in children, so it stays.
  const adult = !knownMinor;
  const bpSysTarget = plan && adult ? bpTargetFor(plan.age) : undefined;
  // What a saved value is graded against, as the phone rows grade it (row-grade.ts): a limit only when certain (US-12 AC21).
  const ctx: GradeContext = { grading: adult ? {} : null, plan };
  /** A column's blood pressure as graded, both halves with their limits; none for a half-pair. */
  const pressureOf = (c: DateColumn): PressureReading | null => c.sys == null || c.dia == null ? null
    : { value: c.sys, comparator: c.limits?.sys, dia: { value: c.dia, comparator: c.limits?.dia } };

  const fieldUnit = (field: 'weightKg' | 'waistCm'): UnitSystem => unitOverrides[field] ?? unitSystem;

  // Reference labels (per row, in the row's display unit): rowTarget's, which
  // the phone's rows print too.
  const refLabel = (row: RowConfig): string | null => rowTarget(
    row.kind === 'bp' ? 'blood_pressure' : row.metric,
    row.kind === 'bp' ? unitSystem : fieldUnit(row.metric === 'weight' ? 'weightKg' : 'waistCm'),
    knownMinor ? null : {},
    plan,
  )?.full ?? null;

  const dateColumns = useMemo(() => buildColumns(vitalsHistory), [vitalsHistory]);

  // Typed values, in the unit they were typed in: a draft, kept on the device
  // as BloodTestTimeline keeps its own. A saved column's cell is on screen
  // while its slot is empty; a BP cell while both halves are, since a column
  // holding one half shows it (US-03 AC2). A blood pressure is one reading:
  // its halves are one cell, which expects the rows under both.
  const onScreen = (date: string, key: VitalsKey) => {
    const col = dateColumns.find(c => c.date === date);
    return !!col && (key === 'sys' || key === 'dia' ? col.sys == null && col.dia == null : col[key] == null);
  };
  const rowsUnder = (day: string, key: VitalsKey): Record<string, string | null> => {
    const col = dateColumns.find(c => c.date === day);
    if (key === 'weight' || key === 'waist') return { [key]: col?.[`${key}Id` as const] ?? null };
    return { systolic_bp: col?.sysId ?? null, diastolic_bp: col?.diaId ?? null };
  };
  const {
    holdsText,
    draft, backfills, type, setDate, unitOf, expected, clashes, taken, settle, refusal,
  } = useMatrixDraft<VitalsKey>(VITALS_DRAFT_KEY, { onScreen, rowsUnder, cellOf: key => (key === 'dia' ? 'sys' : key),
    legacyUnit: key => (key === 'weight' || key === 'waist' ? startUnitOf?.(FIELD_OF[key]) : undefined) });
  // No weight typed here while its row is hidden (the weight shows beside the
  // height): a restored or earlier draft goes, so nothing unseen is saved
  // (US-62 AC13).
  useEffect(() => {
    if (!withoutWeight) return;
    if (draft.values.weight) type([null, 'weight'], '', unitFor('weight'));
    for (const [day, typed] of Object.entries(backfills)) if (typed?.weight) type([day, 'weight'], '', unitFor('weight'));
  }, [withoutWeight]);
  // On a phone the grid sits hidden under rows: tell the page it holds typed text (US-62 AC11).
  useEffect(() => { onHoldsText?.(holdsText); }, [holdsText]);
  const [activeCell, setActiveCell] = useState<string | null>(null);
  // A cell leaving clears only its own mark: another may have taken it since.
  const unmark = (cellId: string) => () => setActiveCell(prev => (prev === cellId ? null : prev));
  const [say, cellMessages] = useLiveRegion('bt-cell-messages');

  // A typed weight or waist keeps the unit it was typed in. A unit switch
  // shows it in the new unit, the same quantity, and the commit is the
  // number typed, never the rounded display (84 kg through lb and back is
  // 84; 80 kg shown as 176 lb is saved as 80 kg).
  const unitFor = (metric: 'weight' | 'waist') => fieldUnit(metric === 'weight' ? 'weightKg' : 'waistCm');
  const typedUnit = (column: string | null, metric: 'weight' | 'waist') => unitOf([column, metric]) ?? unitFor(metric);
  const shownText = (column: string | null, metric: 'weight' | 'waist') => {
    const typed = (column === null ? draft.values : backfills[column])?.[metric] ?? '';
    const unit = typedUnit(column, metric);
    const n = readTypedValue(metric, typed, unit);
    return unit === unitFor(metric) || n === undefined ? typed : formatDisplayValue(metric, toCanonicalValue(metric, n, unit), unitFor(metric));
  };
  // The cell's error is judged as the commit judges it: the typed text in the
  // unit it was typed in, not the rounded display in the new unit. Otherwise
  // near a range end the two disagree (19.9 kg shown as 44 lb, no error, not
  // saved; 79 in shown as 201 cm, "Max 200 cm", saved) (US-05 AC2a). Null is
  // valid, overriding the cell's own check of the shown text.
  const typedError = (column: string | null, metric: 'weight' | 'waist'): string | null => {
    const typed = (column === null ? draft.values : backfills[column])?.[metric] ?? '';
    return typed ? validateTypedValue(metric, typed, typedUnit(column, metric)).error ?? null : null;
  };

  // A saved column's empty cell.
  const setBackfill = (date: string, key: VitalsKey, typed: string) =>
    type([date, key], typed, key === 'weight' || key === 'waist' ? unitFor(key) : undefined);

  // Trend series (SI, oldest → newest) + last value/status per row.
  const trend = useMemo(() => {
    const weight: number[] = [], waist: number[] = [], sysSeries: number[] = [];
    // Which trend points were printed as a limit: drawn hollow, off the line, as the phone rows draw them (US-12 AC20).
    const limits = { weight: [] as boolean[], waist: [] as boolean[], bp: [] as boolean[] };
    let lastW: DateColumn | undefined, lastWa: DateColumn | undefined, lastBp: PressureReading | undefined;
    for (const c of dateColumns) {
      if (c.weight != null) { weight.push(c.weight); limits.weight.push(!!c.limits?.weight); lastW = c; }
      if (c.waist != null) { waist.push(c.waist); limits.waist.push(!!c.limits?.waist); lastWa = c; }
      const bp = pressureOf(c);
      if (bp) { sysSeries.push(bp.value); limits.bp.push(!!bp.comparator || !!bp.dia?.comparator); lastBp = bp; }
    }
    return { weight, waist, sysSeries, limits, lastW, lastWa, lastBp };
  }, [dateColumns]);

  // Columns = existing dates + always-on draft column.
  const columns = useMemo(
    () => [...dateColumns.map(c => ({ kind: 'data' as const, col: c })), { kind: 'draft' as const }],
    [dateColumns],
  );
  const colCount = columns.length;

  const scrollRef = useScrollToRightOnMount<HTMLDivElement>([colCount]);

  const advanceToRest = useAutoAdvance(true);
  const setSimpleDraft = (metric: 'weight' | 'waist', typed: string) => {
    type([null, metric], typed, unitFor(metric));
    if (metric !== 'weight') return;
    onWeightAnswered?.();
    // The weight at rest once complete, for the landing (US-62 AC25b); anything else cancels the wait.
    const valid = (text: string) => !validateTypedValue(metric, text, unitFor(metric)).error;
    if (rested) advanceToRest(/^\d{2,3}$/.test(typed) && valid(typed) ? { ambiguous: /^\d{2}$/.test(typed) && valid(`${typed}0`), advance: rested } : null);
  };

  const setBpDraft = (which: 'sys' | 'dia', typed: string) => type([null, which], typed);

  // Inject an external value (from the chatbot) into the matrix and flash the
  // cell: route to a same-date backfill slot if that slot is EMPTY, else the
  // draft column, then set `activeCell` (the same brand-underline highlight a
  // focused cell gets). The cell is typed with the chat's number in the unit
  // it was stated (mmHg either way): it shows in the cell's own unit, and the
  // commit saves that number exactly (US-03 AC3, AC5). BP routes by metric
  // into its shared sys/dia cell. Returns the cell key so the parent can
  // scroll to it.
  const prefillCell: VitalsPrefillFn = (metric, value, fromUnit, date) => {
    const column = date ? dateColumns.find(c => c.date === date) : undefined;
    // Every branch flashes (highlights) the cell it filled and returns its key.
    const flash = (cellId: string) => { setActiveCell(cellId); return cellId; };
    const typed = String(value);

    if (metric === 'systolic_bp' || metric === 'diastolic_bp') {
      const which = metric === 'systolic_bp' ? 'sys' : 'dia';
      // Backfill only when an existing date column has NO BP recorded yet
      // (both sys+dia absent). A partial/complete BP there is a correction,
      // which goes through the dedicated path, not chat pre-fill.
      if (date && column && column.sys == null && column.dia == null) {
        setBackfill(date, which, typed);
        return flash(`${date}.bp`);
      }
      if (date) setDate(date);
      setBpDraft(which, typed);
      return flash('draft.bp');
    }

    if (metric !== 'weight' && metric !== 'waist') return null;
    if (metric === 'weight' && withoutWeight) return null; // The weight asked beside the height has no row here: its edit goes to that field (US-62 AC13).
    if (date && column && column[metric] == null) {
      type([date, metric], typed, fromUnit, false);
      return flash(`${date}.${metric}`);
    }
    if (date) setDate(date);
    type([null, metric], typed, fromUnit, false);
    return flash(`draft.${metric}`);
  };

  usePrefillRef(prefillCell, prefillRef);

  // Every typed cell, draft and backfills, with what it saves, in the unit
  // it was typed in, or null while it cannot be saved: a value out of range,
  // half a BP pair, or a second value for one slot (the draft dated onto a
  // saved column, and that column's empty cell), which waits for the user to
  // clear one (US-03 AC3). A cell that cannot be saved stays in the draft,
  // with its error. A saved column's cell that is not on screen is not
  // committed (useMatrixDraft).
  const cells = [...Object.entries(backfills), [null, draft.values] as const].flatMap(([column, typed]) =>
    vitalsCellsOf(typed, metric => typedUnit(column, metric)).filter(c => column === null || onScreen(column, c.keys[0])).map(c => ({
      ...c,
      column,
      date: column ?? draft.date,
      values: (column ?? draft.date) === draft.date && c.keys.some(k => clashes(k)) ? null : c.values,
    })));
  const ready = cells.filter(c => c.values);
  const refused = cells.some(c => refusal([c.column, c.keys[0]])); // on screen: one off it has nothing to fix
  const bpClashes = clashes('sys') || clashes('dia');
  const bpTaken = taken('sys') || taken('dia');

  const [saving, setSaving] = useState(false);

  const commit = async () => {
    if (saving || ready.length === 0) return;
    setSaving(true);
    try {
      // The cells that can be saved, each on its day with the rows it
      // expects there, in the unit it was typed in (mmHg is mmHg in both);
      // the parent routes each as it routes the blood-test matrix's
      // (matrix-save.ts) and answers slot by slot. What landed leaves the
      // draft; a cell refused, or half of a pair refused, stays, with why
      // (US-03 AC4).
      const refusedSlots = await onSave(ready.map(({ date, values, column, keys: [key] }) => ({
        date, values: values!, expected: expected([column, key]),
        unit: key === 'weight' || key === 'waist' ? typedUnit(column, key) : unitSystem,
      })));
      settle(ready.flatMap(c => {
        const status = Object.keys(c.values!).map(metric => refusedSlots.get(slotOf(c.date, metric))).find(Boolean);
        return c.keys.map((key): [CellRef<VitalsKey>, string | undefined] => [[c.column, key], status && saveErrorText(status)]);
      }));
      if (refusedSlots.size === 0) setActiveCell(null);
      // A New weight saved here is at rest: Enter lands now, a decimal too (US-62 AC25b, Codex R1).
      if (ready.some(c => c.column === null && c.keys[0] === 'weight' && !refusedSlots.get(slotOf(c.date, 'weight')))) rested?.();
    } finally {
      setSaving(false);
    }
  };

  // Committed as the blood-test matrix commits: on leaving the matrix or on
  // Enter; never while the user is still in it, and never because the page
  // hides (US-03 AC5). A lab upload commits it too (flushRef).
  const rootRef = useRef<HTMLDivElement>(null);
  useSaveOnLeave(rootRef, commit);
  usePrefillRef(commit, flushRef);
  const saveNow = () => { void commit(); };

  return (
    <div ref={rootRef} className="bt-timeline bt-vitals-card">
      <div className="bt-timeline-body">
        <div ref={scrollRef} className="bt-timeline-scroll">
          <div className="bt-timeline-scroll-inner" style={{ '--bt-col-count': colCount } as React.CSSProperties}>
            {/* Header row — Metric | dates… | draft | Trend */}
            <div className="bt-row bt-header-row">
              <div className="bt-cell-name bt-cell-header">Metric</div>
              {columns.map((c, i) => {
                if (c.kind === 'draft') {
                  return <DraftDateCell key="draft" date={draft.date} onChange={setDate}
                                        label="New" ariaLabel="Choose draft date"/>;
                }
                const isPinned = i === columns.length - 2;
                return <BatchDateCell key={c.col.date} date={c.col.date} pinned={isPinned}/>;
              })}
              <div className="bt-row-filler"/>
              <div className="bt-cell-trend bt-cell-header">Trend</div>
            </div>

            {/* Metric rows */}
            {rows.map((row, rowIdx) => {
              const last = rowIdx === rows.length - 1 ? ' bt-row-last' : '';
              const ref = refLabel(row);
              const nameCell = (
                <div className="bt-cell-name">
                  <div className="bt-name-label">{row.label}</div>
                  {row.kind === 'simple' ? (
                    <UnitChip
                      label={getDisplayLabel(row.metric, fieldUnit(row.field as 'weightKg' | 'waistCm'))}
                      onToggle={() => onToggleFieldUnit(row.field)}
                    />
                  ) : (
                    <UnitChip label="mmHg"/>
                  )}
                  {ref && <div className="bt-ref-label">{ref}</div>}
                </div>
              );

              if (row.kind === 'simple') {
                const display = fieldUnit(row.field as 'weightKg' | 'waistCm');
                const sparkPoints = (row.metric === 'weight' ? trend.weight : trend.waist)
                  .map(si => fromCanonicalValue(row.metric, si, display));
                const lastCol = row.metric === 'weight' ? trend.lastW : trend.lastWa;
                const lastStatus = lastCol ? valueStatus(row.metric, lastCol[row.metric]!, ctx, lastCol.limits?.[row.metric]) : null;
                return (
                  <div key={row.metric} className={`bt-row${last}`} data-metric={row.metric}>
                    {nameCell}
                    {columns.map((c, colIdx) => {
                      if (c.kind === 'draft') {
                        const cellId = `draft.${row.metric}`;
                        return (
                          <NumericInputCell
                            key={cellId}
                            metric={row.metric}
                            display={display}
                            value={shownText(null, row.metric)}
                            validationResult={typedError(null, row.metric)}
                            externalError={clashes(row.metric) || taken(row.metric) ? SAME_SLOT : refusal([null, row.metric])}
                            placeholder="—"
                            wrapperClass={`bt-cell-input bt-cell-draft${formStage === 1 && row.metric === 'weight' && (!draft.values.weight || typedError(null, 'weight')) ? ' field-attention' : ''}`}
                            active={activeCell === cellId}
                            onChange={v => setSimpleDraft(row.metric, v)}
                            onFocus={() => setActiveCell(cellId)}
                            onBlur={unmark(cellId)} inputRef={row.metric === 'weight' ? weightRef : undefined}
                            onKeyDown={e => { blockBadNumericKeys(e); if (e.key === 'Enter') { e.preventDefault(); saveNow(); } }}
                          />
                        );
                      }
                      const v = row.metric === 'weight' ? c.col.weight : c.col.waist;
                      const id = row.metric === 'weight' ? c.col.weightId : c.col.waistId;
                      const isPinned = colIdx === columns.length - 2;
                      const cellId = `${c.col.date}.${row.metric}`;
                      if (v == null) {
                        // Empty slot → click-to-input (mirrors the blood-test
                        // matrix's BackfillCell). Commits a NEW measurement at
                        // this past date via the validated save path.
                        return (
                          <BackfillCell
                            key={cellId}
                            metric={row.metric}
                            display={display}
                            value={shownText(c.col.date, row.metric)}
                            validationResult={typedError(c.col.date, row.metric)}
                            error={c.col.date === draft.date && clashes(row.metric) ? SAME_SLOT : refusal([c.col.date, row.metric])}
                            pinned={isPinned}
                            active={activeCell === cellId}
                            onChange={val => { setBackfill(c.col.date, row.metric, val); if (row.metric === 'weight') onWeightAnswered?.(true); }}
                            onFocus={() => setActiveCell(cellId)}
                            onBlur={unmark(cellId)}
                            onEnter={saveNow}
                          />
                        );
                      }
                      const comparator = c.col.limits?.[row.metric];
                      const status = valueStatus(row.metric, v, ctx, comparator);
                      return (
                        <ValueCell
                          key={cellId}
                          metric={row.metric}
                          display={display}
                          value={v}
                          comparator={comparator}
                          rowId={id}
                          status={status}
                          ungraded={limitUngraded(row.metric, status, ctx, { value: v, comparator })}
                          pinned={isPinned}
                          onActivate={() => setActiveCell(cellId)}
                          onDeactivate={unmark(cellId)}
                          onCorrect={onCorrectValue}
                          say={say}
                        />
                      );
                    })}
                    <div className="bt-row-filler"/>
                    <div className="bt-cell-trend">
                      {sparkPoints.length >= 2 && <Sparkline points={sparkPoints} limits={trend.limits[row.metric]}/>}
                      <span className={`bt-status-tick bt-status-${lastStatus ?? 'none'}`}/>
                    </div>
                  </div>
                );
              }

              // BP row.
              const bpSpark = trend.sysSeries;
              const lastBpStatus = trend.lastBp ? pressureStatus(trend.lastBp, ctx) : null;
              return (
                <div key="bp" className={`bt-row${last}`}>
                  {nameCell}
                  {columns.map((c, colIdx) => {
                    if (c.kind === 'draft') {
                      const { sys = '', dia = '' } = draft.values;
                      return (
                        <BpInputCell
                          key="draft.bp"
                          sys={sys}
                          dia={dia}
                          clash={bpClashes || bpTaken ? SAME_SLOT : refusal([null, 'sys']) ?? undefined}
                          active={activeCell === 'draft.bp'}
                          previewStatus={bpStatus(parseLocalisedNumber(sys), parseLocalisedNumber(dia), bpSysTarget)}
                          onSysChange={v => setBpDraft('sys', v)}
                          onDiaChange={v => setBpDraft('dia', v)}
                          onEnter={saveNow}
                        />
                      );
                    }
                    const isPinned = colIdx === columns.length - 2;
                    if (c.col.sys == null && c.col.dia == null) {
                      // Empty BP slot → click-to-input, reusing the SAME guarded
                      // dual sys/dia component as the draft column (one source of
                      // truth for the 542e811 blur/half-pair guards). Commits a
                      // paired systolic_bp + diastolic_bp at this past date via
                      // the validated save path.
                      const { sys = '', dia = '' } = backfills[c.col.date] ?? {};
                      return (
                        <BpInputCell
                          key={`${c.col.date}.bp`}
                          sys={sys}
                          dia={dia}
                          clash={c.col.date === draft.date && bpClashes ? SAME_SLOT : refusal([c.col.date, 'sys']) ?? undefined}
                          active={activeCell === `${c.col.date}.bp`}
                          previewStatus={bpStatus(parseLocalisedNumber(sys), parseLocalisedNumber(dia), bpSysTarget)}
                          pinned={isPinned}
                          backfill
                          onSysChange={v => setBackfill(c.col.date, 'sys', v)}
                          onDiaChange={v => setBackfill(c.col.date, 'dia', v)}
                          onEnter={saveNow}
                        />
                      );
                    }
                    // A saved reading, or the half of one a column holds, shown
                    // as it is ("130/—"): a pair is never typed over a value
                    // the user cannot see (US-03 AC2).
                    // A limit half reads with its symbol, and the pair is graded only when certain (US-12 AC21).
                    const reading = pressureOf(c.col);
                    const status = reading ? pressureStatus(reading, ctx) : null;
                    const ungraded = !!reading && limitUngraded('blood_pressure', status, ctx, reading);
                    const half = (v: number | undefined, comparator?: Comparator) => v == null ? '—' : comparator ? limitText(v, 0, comparator) : v;
                    return (
                      <div key={`${c.col.date}.bp`} className={`bt-cell-value${isPinned ? ' bt-cell-pinned' : ''}`} title={ungraded ? LIMIT_NOT_GRADED : undefined}>
                        <span className="bt-value-num bt-value-num--bp num">{half(c.col.sys, c.col.limits?.sys)}/{half(c.col.dia, c.col.limits?.dia)}</span>
                        <span className={`bt-status-tick bt-status-${status ?? 'none'}`}/>
                        {ungraded && <span className="hr-sr-only">{LIMIT_NOT_GRADED}</span>}
                      </div>
                    );
                  })}
                  <div className="bt-row-filler"/>
                  <div className="bt-cell-trend">
                    {bpSpark.length >= 2 && <Sparkline points={bpSpark} limits={trend.limits.bp}/>}
                    <span className={`bt-status-tick bt-status-${lastBpStatus ?? 'none'}`}/>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        {refused && !saving && (
          <div className="bt-save-error" aria-live="polite">{SAVE_FAILED}</div>
        )}
        {cellMessages}
      </div>
    </div>
  );
}
