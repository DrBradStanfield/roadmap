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
// on user demographics that the shared `statusOf` in `lib/blood-test-cell.ts`
// doesn't carry, so they live here. Everything else reuses the `.bt-*` CSS,
// the matrix's `Sparkline`, `NumericInputCell`, `DraftDateCell`, and `UnitChip`.

import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import {
  type ApiMeasurement,
  type HealthInputs,
  type MetricType,
  type UnitSystem,
  toCanonicalValue,
  fromCanonicalValue,
  formatDisplayValue,
  getDisplayLabel,
  parseLocalisedNumber,
  calculateIBW,
} from '@roadmap/health-core';
import { slotOf, type CorrectFn, type Refused, type SaveTask } from '../lib/matrix-save';
import {
  type Status,
  blockBadNumericKeys,
  blockNonIntegerKeys,
  bpSysAdvance,
  validateTypedValue,
} from '../lib/blood-test-cell';
import { VITALS_DRAFT_KEY } from '../lib/storage';
import { useDraftMirror, useMatrixDraft, type CellRef } from '../lib/useMatrixDraft';
import { useScrollToRightOnMount } from '../lib/useScrollToRightOnMount';
import { useSaveOnLeave } from '../lib/useSaveOnLeave';
import { usePrefillRef } from '../lib/usePrefillRef';
import { Sparkline, ValueCell, BatchDateCell, BackfillCell, SAVE_ERRORS, SAVE_FAILED, SAME_SLOT } from './BloodTestTimeline';
import { NumericInputCell } from './NumericInputCell';
import { DraftDateCell } from './DraftDateCell';
import { UnitChip } from './UnitChip';

interface StartingInfoVitalsProps {
  inputs: Partial<HealthInputs>;
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
  /** The draft values the suggestions engine (which reads `inputs[field]`)
   *  may use, in SI; undefined leaves the field to the record. */
  onFieldChange: (field: keyof HealthInputs, value: number | undefined) => void;
  /** Used to pulse the weight draft cell at stage 2 (the progressive-
   *  disclosure gate that unlocks the blood-test panel). */
  formStage: 1 | 2 | 3;
  /** Called after the user types a valid weight — continues the
   *  height → weight → email focus chain from the legacy form. */
  onAutoFocusEmail?: () => void;
  /** Per-field unit overrides — clicking the weight/waist chip toggles
   *  just that metric's display unit (kg ↔ lbs, cm ↔ inches). */
  unitOverrides: Record<string, UnitSystem>;
  onToggleFieldUnit: (field: string) => void;
  /** When provided, the matrix exposes an imperative `prefill(metric, value,
   *  fromUnit, date)` so the chatbot can inject a vitals value into the
   *  draft/backfill cell (highlighted, for the user to Save). Mirrors
   *  BloodTestTimeline's prefillRef seam — its presence also signals to the
   *  parent that the vitals matrix (not the legacy form) is mounted, so chat
   *  edits should flash a cell here rather than silently set a plain field. */
  prefillRef?: MutableRefObject<VitalsPrefillFn | null>;
  /** Filled with the matrix's commit, so a lab upload commits the draft
   *  before its own save (US-03 AC5). */
  flushRef?: MutableRefObject<(() => Promise<void>) | null>;
}

/** Inject a vitals value into the matrix from outside (e.g. the chatbot).
 *  `value` is in `fromUnit`; the matrix converts to its own display unit.
 *  `date` null = today's draft column. BP routes by metric (systolic_bp /
 *  diastolic_bp) into the shared sys/dia cell. Returns the cell key it filled
 *  so the parent can scroll/highlight it (or null for an unhandled metric). */
export type VitalsPrefillFn = (
  metric: MetricType,
  value: number,
  fromUnit: UnitSystem,
  date: string | null,
) => string | null;

/** Decide where a chatbot vitals edit should land. When the vitals matrix is
 *  mounted (`matrixMounted`, i.e. its prefill ref is registered) the value
 *  routes to the matrix cell so it pre-fills AND flashes; otherwise it goes to
 *  the plain form field (fresh users, no flash). Pure so HealthTool's routing
 *  is unit-testable without rendering. */
export function routeVitalsEdit(matrixMounted: boolean): 'matrix' | 'field' {
  return matrixMounted ? 'matrix' : 'field';
}

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

// ── Status thresholds (demographic-dependent — live here) ────────────────

function weightStatus(siKg: number | null | undefined, heightCm?: number, sex?: 'male' | 'female'): Status {
  if (siKg == null || Number.isNaN(siKg) || heightCm == null || !sex) return null;
  const ibw = calculateIBW(heightCm, sex);
  if (siKg >= ibw - 5 && siKg <= ibw + 2) return 'ok';
  if (siKg <= ibw + 5) return 'warn';
  return 'bad';
}
function waistStatus(siCm: number | null | undefined, heightCm?: number): Status {
  if (siCm == null || Number.isNaN(siCm) || heightCm == null) return null;
  const target = heightCm * 0.5;
  if (siCm <= target) return 'ok';
  if (siCm <= target + 8) return 'warn';
  return 'bad';
}
function bpStatus(sys?: number | null, dia?: number | null, age?: number): Status {
  if (sys == null || dia == null || Number.isNaN(sys) || Number.isNaN(dia)) return null;
  const sysTarget = age != null && age >= 65 ? 130 : 120;
  const diaTarget = 80;
  if (sys < sysTarget && dia < diaTarget) return 'ok';
  if (sys < sysTarget + 10 && dia < diaTarget + 5) return 'warn';
  return 'bad';
}
function simpleStatus(metric: 'weight' | 'waist', si: number | null | undefined, heightCm?: number, sex?: 'male' | 'female'): Status {
  return metric === 'weight' ? weightStatus(si, heightCm, sex) : waistStatus(si, heightCm);
}

// ── Date helpers ─────────────────────────────────────────────────────────

function isoOnly(s: string): string { return s.slice(0, 10); }

// ── Blood-pressure helpers (atomic sys+dia pair) ─────────────────────────
// BP is a two-field value: a save must commit systolic AND diastolic together
// or neither. These ranges gate both the live `onFieldChange` mirror and the
// commit, so a half-entered or mid-typed pair (e.g. "120 / 8") never lands.
const BP_SYS_MIN = 60, BP_SYS_MAX = 250;
const BP_DIA_MIN = 40, BP_DIA_MAX = 150;

/** True only when both fields hold a valid, in-physiological-range number —
 *  the gate that stops a commit from saving a half-entered BP pair. */
export function bpPairReady(sys: string, dia: string): boolean {
  const s = parseLocalisedNumber(sys);
  const d = parseLocalisedNumber(dia);
  return (
    s != null && s >= BP_SYS_MIN && s <= BP_SYS_MAX &&
    d != null && d >= BP_DIA_MIN && d <= BP_DIA_MAX
  );
}

// ── Per-date model ───────────────────────────────────────────────────────
// One column per distinct date. Each column carries the SI value + row id for
// every vital recorded that day (sparse — a date may hold only a weight).

export interface DateColumn {
  date: string;
  weight?: number; weightId?: string;
  waist?: number; waistId?: string;
  sys?: number; sysId?: string;
  dia?: number; diaId?: string;
}

// Exported for unit testing — folds the flat vitals history into one column
// per distinct date (sparse: a date may carry only some vitals), sorted oldest
// → newest. sys+dia sharing a date are paired into the same column.
export function buildColumns(rows: ApiMeasurement[]): DateColumn[] {
  const byDate = new Map<string, DateColumn>();
  const ensure = (date: string) => {
    let c = byDate.get(date);
    if (!c) { c = { date }; byDate.set(date, c); }
    return c;
  };
  for (const r of rows) {
    const date = isoOnly(r.recordedAt);
    const c = ensure(date);
    if (r.metricType === 'weight') { c.weight = r.value; c.weightId = r.id; }
    else if (r.metricType === 'waist') { c.waist = r.value; c.waistId = r.id; }
    else if (r.metricType === 'systolic_bp') { c.sys = r.value; c.sysId = r.id; }
    else if (r.metricType === 'diastolic_bp') { c.dia = r.value; c.diaId = r.id; }
  }
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

/** What is typed in a vitals cell: a weight, a waist, or one half of a
 *  blood pressure (sys and dia share one cell). */
type VitalsKey = 'weight' | 'waist' | 'sys' | 'dia';
/** The form field each one stands in for, while it may (useDraftMirror). */
const FIELD_OF = { weight: 'weightKg', waist: 'waistCm', sys: 'systolicBp', dia: 'diastolicBp' } as const;

/** One column's typed vitals (the draft's, or a saved column's empty cells)
 *  as the cells a commit saves: a weight, a waist, a BP pair committed
 *  together (mmHg is stored as typed). `values` (SI, by metric) is null for a
 *  cell that cannot be saved as it stands: out of range, not a number, or
 *  half a pair. Exported for unit testing. */
export function vitalsCellsOf(
  typed: Partial<Record<VitalsKey, string>>,
  unitFor: (metric: 'weight' | 'waist') => UnitSystem,
): Array<{ keys: VitalsKey[]; values: Record<string, number> | null }> {
  const cells: Array<{ keys: VitalsKey[]; values: Record<string, number> | null }> = [];
  for (const metric of ['weight', 'waist'] as const) {
    const text = typed[metric];
    if (!text) continue;
    const unit = unitFor(metric);
    const ok = !validateTypedValue(metric, text, unit).error;
    cells.push({ keys: [metric], values: ok ? { [metric]: toCanonicalValue(metric, parseLocalisedNumber(text)!, unit) } : null });
  }
  const { sys = '', dia = '' } = typed;
  if (sys || dia) {
    const ok = bpPairReady(sys, dia);
    cells.push({ keys: ['sys', 'dia'], values: ok ? { systolic_bp: parseLocalisedNumber(sys)!, diastolic_bp: parseLocalisedNumber(dia)! } : null });
  }
  return cells;
}

// ── Component ───────────────────────────────────────────────────────────

export function StartingInfoVitals({
  inputs, vitalsHistory, unitSystem, onSave, onCorrectValue,
  onFieldChange, formStage, onAutoFocusEmail, unitOverrides, onToggleFieldUnit,
  prefillRef, flushRef,
}: StartingInfoVitalsProps) {
  const heightCm = inputs.heightCm;
  const sex = inputs.sex;
  const age = useMemo(() => {
    if (!inputs.birthYear) return undefined;
    const now = new Date();
    const m = inputs.birthMonth ?? 1;
    let a = now.getFullYear() - inputs.birthYear;
    if (now.getMonth() + 1 < m) a -= 1;
    return a;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputs.birthYear, inputs.birthMonth]);

  const ibwKg = useMemo(() => (heightCm && sex ? calculateIBW(heightCm, sex) : undefined), [heightCm, sex]);
  const waistTargetCm = useMemo(() => (heightCm ? heightCm * 0.5 : undefined), [heightCm]);
  const bpSysTarget = age != null && age >= 65 ? 130 : 120;

  const fieldUnit = (field: 'weightKg' | 'waistCm'): UnitSystem => unitOverrides[field] ?? unitSystem;

  // Reference labels (per row, in the row's display unit).
  const refLabel = (row: RowConfig): string => {
    if (row.kind === 'bp') return `Target: <${bpSysTarget}/80 mmHg`;
    if (row.metric === 'weight') {
      const u = fieldUnit('weightKg');
      return ibwKg != null
        ? `Target: ${formatDisplayValue('weight', ibwKg, u)} ${getDisplayLabel('weight', u)}`
        : 'Set sex + height to see target';
    }
    const u = fieldUnit('waistCm');
    return waistTargetCm != null
      ? `Target: <${formatDisplayValue('waist', waistTargetCm, u)} ${getDisplayLabel('waist', u)}`
      : 'Set height to see target';
  };

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
  const latestDay = (key: VitalsKey) => [...dateColumns].reverse().find(c => c[key] != null)?.date;
  const {
    draft, backfills, type, setDate, unitOf, expected, clashes, taken, lends, settle, refusal,
  } = useMatrixDraft<VitalsKey>(VITALS_DRAFT_KEY, { onScreen, rowsUnder, latestDay, cellOf: key => (key === 'dia' ? 'sys' : key) });
  const [activeCell, setActiveCell] = useState<string | null>(null);

  // A typed weight or waist keeps the unit it was typed in. A unit switch
  // shows it in the new unit, the same quantity, and the commit is the
  // number typed, never the rounded display (84 kg through lb and back is
  // 84; 80 kg shown as 176 lb is saved as 80 kg).
  const unitFor = (metric: 'weight' | 'waist') => fieldUnit(metric === 'weight' ? 'weightKg' : 'waistCm');
  const typedUnit = (column: string | null, metric: 'weight' | 'waist') => unitOf([column, metric]) ?? unitFor(metric);
  const shownText = (column: string | null, metric: 'weight' | 'waist') => {
    const typed = (column === null ? draft.values : backfills[column])?.[metric] ?? '';
    const n = parseLocalisedNumber(typed);
    const unit = typedUnit(column, metric);
    return unit === unitFor(metric) || n === undefined ? typed : formatDisplayValue(metric, toCanonicalValue(metric, n, unit), unitFor(metric));
  };

  // A saved column's empty cell. Backfilling a PAST date deliberately does NOT
  // stand in for the latest value in the plan (unlike the draft column).
  const setBackfill = (date: string, key: VitalsKey, typed: string) =>
    type([date, key], typed, key === 'weight' || key === 'waist' ? unitFor(key) : undefined);

  // Trend series (SI, oldest → newest) + last value/status per row.
  const trend = useMemo(() => {
    const weight: number[] = [], waist: number[] = [], sysSeries: number[] = [];
    let lastW: number | undefined, lastWa: number | undefined;
    let lastSys: number | undefined, lastDia: number | undefined;
    for (const c of dateColumns) {
      if (c.weight != null) { weight.push(c.weight); lastW = c.weight; }
      if (c.waist != null) { waist.push(c.waist); lastWa = c.waist; }
      if (c.sys != null && c.dia != null) { sysSeries.push(c.sys); lastSys = c.sys; lastDia = c.dia; }
    }
    return { weight, waist, sysSeries, lastW, lastWa, lastSys, lastDia };
  }, [dateColumns]);

  // Columns = existing dates + always-on draft column.
  const columns = useMemo(
    () => [...dateColumns.map(c => ({ kind: 'data' as const, col: c })), { kind: 'draft' as const }],
    [dateColumns],
  );
  const colCount = columns.length;

  const scrollRef = useScrollToRightOnMount<HTMLDivElement>([colCount]);

  const setSimpleDraft = (metric: 'weight' | 'waist', typed: string) => {
    type([null, metric], typed, unitFor(metric));
    const n = parseLocalisedNumber(typed);

    // Weight only: continue the height → weight → email focus chain.
    if (metric === 'weight' && onAutoFocusEmail && !focusedEmailRef.current && n != null && !validateTypedValue(metric, typed, unitFor(metric)).error) {
      if (focusTimerRef.current) clearTimeout(focusTimerRef.current);
      if (/^\d{2,3}$/.test(typed) && n >= 30 && n <= 400) {
        const couldExtend = /^\d{2}$/.test(typed) && n * 10 <= 400;
        if (!couldExtend) {
          focusedEmailRef.current = true;
          requestAnimationFrame(() => onAutoFocusEmail());
        } else {
          focusTimerRef.current = setTimeout(() => {
            focusedEmailRef.current = true;
            onAutoFocusEmail();
          }, 800);
        }
      }
    }
  };
  const focusedEmailRef = useRef(false);
  const focusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    if (date && column && column[metric] == null) {
      type([date, metric], typed, fromUnit);
      return flash(`${date}.${metric}`);
    }
    if (date) setDate(date);
    type([null, metric], typed, fromUnit);
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

  // What the plan and the chat read of the draft (US-03 AC6, `lends`): a
  // value it could save, clear of clashes. Each half of a blood pressure
  // counts on its own, in range.
  const standsIn = (key: VitalsKey): number | undefined => {
    const text = draft.values[key];
    if (!text || !lends(key) || clashes(key)) return undefined;
    const n = parseLocalisedNumber(text);
    if (key === 'sys') return n != null && n >= BP_SYS_MIN && n <= BP_SYS_MAX ? n : undefined;
    if (key === 'dia') return n != null && n >= BP_DIA_MIN && n <= BP_DIA_MAX ? n : undefined;
    const unit = typedUnit(null, key);
    return validateTypedValue(key, text, unit).error ? undefined : toCanonicalValue(key, n!, unit);
  };
  useDraftMirror((Object.keys(FIELD_OF) as VitalsKey[]).map(key => [FIELD_OF[key], standsIn(key)]), onFieldChange);

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
        return c.keys.map((key): [CellRef<VitalsKey>, string | undefined] => [[c.column, key], status && SAVE_ERRORS[status]]);
      }));
      if (refusedSlots.size === 0) setActiveCell(null);
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
            {ROWS.map((row, rowIdx) => {
              const last = rowIdx === ROWS.length - 1 ? ' bt-row-last' : '';
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
                  <div className="bt-ref-label">{refLabel(row)}</div>
                </div>
              );

              if (row.kind === 'simple') {
                const display = fieldUnit(row.field as 'weightKg' | 'waistCm');
                const sparkPoints = (row.metric === 'weight' ? trend.weight : trend.waist)
                  .map(si => fromCanonicalValue(row.metric, si, display));
                const lastSi = row.metric === 'weight' ? trend.lastW : trend.lastWa;
                const lastStatus = lastSi != null ? simpleStatus(row.metric, lastSi, heightCm, sex) : null;
                return (
                  <div key={row.metric} className={`bt-row${last}`}>
                    {nameCell}
                    {columns.map((c, colIdx) => {
                      if (c.kind === 'draft') {
                        const cellId = `draft.${row.metric}`;
                        return (
                          <NumericInputCell
                            key={cellId}
                            metric={row.metric}
                            display={display}
                            sex={sex}
                            value={shownText(null, row.metric)}
                            externalError={clashes(row.metric) || taken(row.metric) ? SAME_SLOT : refusal([null, row.metric])}
                            placeholder="—"
                            wrapperClass={`bt-cell-input bt-cell-draft${formStage === 2 && row.metric === 'weight' && inputs.weightKg === undefined ? ' field-attention' : ''}`}
                            active={activeCell === cellId}
                            onChange={v => setSimpleDraft(row.metric, v)}
                            onFocus={() => setActiveCell(cellId)}
                            onBlur={() => setActiveCell(null)}
                            onKeyDown={e => { blockBadNumericKeys(e); if (e.key === 'Enter') { e.preventDefault(); saveNow(); } }}
                          />
                        );
                      }
                      const v = row.metric === 'weight' ? c.col.weight : c.col.waist;
                      const id = row.metric === 'weight' ? c.col.weightId : c.col.waistId;
                      const isPinned = colIdx === columns.length - 2;
                      if (v == null) {
                        // Empty slot → click-to-input (mirrors the blood-test
                        // matrix's BackfillCell). Commits a NEW measurement at
                        // this past date via the validated save path.
                        const cellId = `${c.col.date}.${row.metric}`;
                        return (
                          <BackfillCell
                            key={cellId}
                            metric={row.metric}
                            display={display}
                            value={shownText(c.col.date, row.metric)}
                            error={c.col.date === draft.date && clashes(row.metric) ? SAME_SLOT : refusal([c.col.date, row.metric])}
                            pinned={isPinned}
                            active={activeCell === cellId}
                            onChange={val => setBackfill(c.col.date, row.metric, val)}
                            onFocus={() => setActiveCell(cellId)}
                            onBlur={() => setActiveCell(null)}
                            onEnter={saveNow}
                          />
                        );
                      }
                      return (
                        <ValueCell
                          key={`${c.col.date}.${row.metric}`}
                          metric={row.metric}
                          display={display}
                          sex={sex}
                          value={v}
                          rowId={id}
                          status={simpleStatus(row.metric, v, heightCm, sex)}
                          pinned={isPinned}
                          onActivate={() => setActiveCell(`${c.col.date}.${row.metric}`)}
                          onDeactivate={() => setActiveCell(null)}
                          onCorrect={onCorrectValue}
                        />
                      );
                    })}
                    <div className="bt-row-filler"/>
                    <div className="bt-cell-trend">
                      {sparkPoints.length >= 2 && <Sparkline points={sparkPoints}/>}
                      <span className={`bt-status-tick bt-status-${lastStatus ?? 'none'}`}/>
                    </div>
                  </div>
                );
              }

              // BP row.
              const bpSpark = trend.sysSeries;
              const lastBpStatus = trend.lastSys != null ? bpStatus(trend.lastSys, trend.lastDia, age) : null;
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
                          previewStatus={bpStatus(parseLocalisedNumber(sys), parseLocalisedNumber(dia), age)}
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
                          previewStatus={bpStatus(parseLocalisedNumber(sys), parseLocalisedNumber(dia), age)}
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
                    const status = bpStatus(c.col.sys, c.col.dia, age);
                    return (
                      <div key={`${c.col.date}.bp`} className={`bt-cell-value${isPinned ? ' bt-cell-pinned' : ''}`}>
                        <span className="bt-value-num bt-value-num--bp num">{c.col.sys ?? '—'}/{c.col.dia ?? '—'}</span>
                        <span className={`bt-status-tick bt-status-${status ?? 'none'}`}/>
                      </div>
                    );
                  })}
                  <div className="bt-row-filler"/>
                  <div className="bt-cell-trend">
                    {bpSpark.length >= 2 && <Sparkline points={bpSpark}/>}
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
      </div>
    </div>
  );
}

// ── BP input cell — dual sys/dia input in one column ─────────────────────
// ONE guarded BP input shared by the draft column (today's reading) AND the
// historical backfill cells (a past empty BP slot). Both commit only a
// complete in-range pair (`bpPairReady`, applied by the caller's save fold);
// moving systolic → diastolic never saves, because nothing inside the matrix
// does. `backfill`/`pinned` only swap the wrapper classes so it matches the
// surrounding empty-cell vs draft-cell styling.

function BpInputCell({
  sys, dia, clash, previewStatus, onSysChange, onDiaChange, onEnter, pinned, backfill, active,
}: {
  sys: string;
  dia: string;
  /** Why the pair cannot be saved as it stands (`SAME_SLOT`). */
  clash?: string;
  previewStatus: Status;
  onSysChange: (v: string) => void;
  onDiaChange: (v: string) => void;
  onEnter: () => void;
  /** 2nd-from-right column highlight (matches BatchDateCell pinning). */
  pinned?: boolean;
  /** Style as an empty-slot backfill cell rather than the draft column. */
  backfill?: boolean;
  /** Brand-underline highlight (the same `bt-input-active` cue a focused cell
   *  gets) — used so a chatbot prefill flashes the filled BP cell. */
  active?: boolean;
}) {
  const cellRef = useRef<HTMLDivElement>(null);
  const sysRef = useRef<HTMLInputElement>(null);
  const diaRef = useRef<HTMLInputElement>(null);
  const advanceTimer = useRef<number | null>(null);
  useEffect(() => () => { if (advanceTimer.current) window.clearTimeout(advanceTimer.current); }, []);
  // BP is integer-only (US-02 AC4) — block non-digit keystrokes; paste is
  // sanitised in the change handlers below.
  const onKey: React.KeyboardEventHandler<HTMLInputElement> = (e) => {
    blockNonIntegerKeys(e);
    if (e.key === 'Enter') { e.preventDefault(); onEnter(); }
  };
  // Auto-advance systolic → diastolic (US-02 AC6): immediately for an
  // unambiguous 3-digit value, after 800ms for a plausible 2-digit one.
  // Never steal focus if the user already left systolic or dia has content.
  const handleSysChange = (raw: string) => {
    const v = raw.replace(/[^0-9]/g, '');
    onSysChange(v);
    if (advanceTimer.current) { window.clearTimeout(advanceTimer.current); advanceTimer.current = null; }
    if (dia !== '') return;
    const adv = bpSysAdvance(v);
    if (adv === 'advance') diaRef.current?.focus();
    else if (adv === 'defer') {
      advanceTimer.current = window.setTimeout(() => {
        if (document.activeElement === sysRef.current) diaRef.current?.focus();
      }, 800);
    }
  };
  const handleDiaChange = (raw: string) => onDiaChange(raw.replace(/[^0-9]/g, ''));
  // Visible range validation (US-02 AC5) — same inline-error pattern as
  // NumericInputCell (this is the one cell that can't reuse it directly).
  const sysError = validateTypedValue('systolic_bp', sys, 'si').error ?? clash;
  const diaError = validateTypedValue('diastolic_bp', dia, 'si').error ?? clash;
  const error = sysError ?? diaError;
  // `bt-cell-value` carries the fixed column width (flex: 0 0 var(--bt-value-w)).
  // The backfill branch was missing it, so an empty BP slot collapsed to its
  // content width (~33px) and pushed every column to its right out of
  // alignment with the weight/waist rows. The draft branch already had it.
  const wrapperClass = backfill
    ? `bt-cell-value bt-cell-backfill${pinned ? ' bt-cell-pinned' : ''}`
    : 'bt-cell-value bt-cell-input bt-cell-draft';
  // The two BP inputs are ~35px wide inside a 91px mobile column — near-misses
  // land on cell padding, the "/" separator, or the tick footer, all inert
  // (dead-click cluster, 2026-08 audit / US-02). Route any click on those
  // non-input parts to the systolic input; clicks ON an input are untouched
  // (so aiming at diastolic still works).
  const focusSysFromShell: React.MouseEventHandler<HTMLDivElement> = (e) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    cellRef.current?.querySelector('input')?.focus();
  };
  return (
    <div ref={cellRef} className={wrapperClass} onClick={focusSysFromShell}>
      <div className="bt-vitals-bp-inputs">
        <input ref={sysRef} className={`bt-input${active ? ' bt-input-active' : ''}${sysError ? ' bt-input-error' : ''}`}
               inputMode="numeric" pattern="[0-9]*" placeholder="sys" size={1} aria-label="Systolic blood pressure"
               aria-invalid={!!sysError} title={sysError ?? undefined}
               value={sys} onChange={e => handleSysChange(e.target.value)} onKeyDown={onKey}/>
        <span className="bt-vitals-bp-sep">/</span>
        <input ref={diaRef} className={`bt-input${active ? ' bt-input-active' : ''}${diaError ? ' bt-input-error' : ''}`}
               inputMode="numeric" pattern="[0-9]*" placeholder="dia" size={1} aria-label="Diastolic blood pressure"
               aria-invalid={!!diaError} title={diaError ?? undefined}
               value={dia} onChange={e => handleDiaChange(e.target.value)} onKeyDown={onKey}/>
      </div>
      <div className="bt-cell-foot">
        {error
          ? <span className="bt-input-error-text">{error}</span>
          : <span className={`bt-status-tick bt-status-${previewStatus ?? 'none'}`}/>}
      </div>
    </div>
  );
}
