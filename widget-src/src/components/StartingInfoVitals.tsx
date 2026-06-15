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

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  type ApiMeasurement,
  type HealthInputs,
  type UnitSystem,
  toCanonicalValue,
  fromCanonicalValue,
  formatDisplayValue,
  getDisplayLabel,
  parseLocalisedNumber,
  calculateIBW,
} from '@roadmap/health-core';
import { routeTasksToSaves, type SaveTask, type CorrectFn } from '../lib/matrix-save';
import {
  type Status,
  blockBadNumericKeys,
  validateTypedValue,
} from '../lib/blood-test-cell';
import { useScrollToRightOnMount } from '../lib/useScrollToRightOnMount';
import { useDebouncedSave } from '../lib/useDebouncedSave';
import { Sparkline, ValueCell, BatchDateCell, BackfillCell } from './BloodTestTimeline';
import { NumericInputCell } from './NumericInputCell';
import { DraftDateCell } from './DraftDateCell';
import { UnitChip } from './UnitChip';

interface StartingInfoVitalsProps {
  inputs: Partial<HealthInputs>;
  /** Full per-metric history (filtered to vitals metrics). Latest-per-metric
   *  is insufficient — the matrix needs the timeline. */
  vitalsHistory: ApiMeasurement[];
  unitSystem: UnitSystem;
  isLoggedIn: boolean;
  /** Same handler used by BloodTestTimeline. Sends SI values keyed by
   *  metricType + an ISO `yyyy-mm-dd` date through `handleSaveLongitudinal`. */
  onSave: (date: string, values: Record<string, number>) => Promise<void>;
  /** Click-to-correct handler for saved single-value cells (weight / waist).
   *  Same prop the blood-test matrix uses. BP cells stay display-only (a
   *  sys/dia cell is ambiguous to correct in place). */
  onCorrectValue?: CorrectFn;
  /** Mirror typed draft values back into `inputs[field]` (in SI). Needed so
   *  the suggestions engine sees live drafts AND so guest users' typed
   *  values persist via the parent's localStorage auto-save. */
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
  { kind: 'simple', metric: 'waist', field: 'waistCm', label: 'Waist\nCircumference' },
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

function todayIso(): string { return new Date().toISOString().slice(0, 10); }
function isoOnly(s: string): string { return s.slice(0, 10); }

// ── Blood-pressure helpers (atomic sys+dia pair) ─────────────────────────
// BP is a two-field value: a save must commit systolic AND diastolic together
// or neither. These ranges gate both the live `onFieldChange` mirror and the
// auto-save, so a half-entered or mid-typed pair (e.g. "120 / 8") never lands.
const BP_SYS_MIN = 60, BP_SYS_MAX = 250;
const BP_DIA_MIN = 40, BP_DIA_MAX = 150;

/** True only when both fields hold a valid, in-physiological-range number —
 *  the gate that stops an auto-save from committing a half-entered BP pair. */
export function bpPairReady(sys: string, dia: string): boolean {
  const s = parseLocalisedNumber(sys);
  const d = parseLocalisedNumber(dia);
  return (
    s != null && s >= BP_SYS_MIN && s <= BP_SYS_MAX &&
    d != null && d >= BP_DIA_MIN && d <= BP_DIA_MAX
  );
}

/** True when a blur moves focus OUTSIDE the given cell (or focus is lost).
 *  systolic ↔ diastolic share one cell, so a blur between them returns false
 *  and must not trigger a save — only leaving the whole cell should. */
export function blurLeavesCell(related: HTMLElement | null, cell: HTMLElement | null): boolean {
  if (!cell) return true;
  if (!related) return true;
  return !cell.contains(related);
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

// Draft typed values (display unit) keyed by row.
interface DraftRow {
  date: string;
  weight: string;
  waist: string;
  sys: string;
  dia: string;
}
function emptyDraft(): DraftRow {
  return { date: todayIso(), weight: '', waist: '', sys: '', dia: '' };
}

// Backfill typed values for EMPTY cells in existing date columns: a user can
// click an empty weight/waist slot — or an empty BP slot — at a past date and
// type a value. Single-value metrics (weight/waist) live in `simple`, keyed by
// `${date}|${metric}`; BP is an atomic sys/dia pair keyed by date in `bp`.
// Mirrors BloodTestTimeline's backfill map, plus a paired BP entry the
// blood-test matrix doesn't need.
type BackfillMetric = 'weight' | 'waist';
interface BackfillState {
  simple: Record<string, string>; // `${date}|${metric}` → typed value
  bp: Record<string, { sys: string; dia: string }>; // date → typed sys/dia pair
}

function emptyBackfills(): BackfillState {
  return { simple: {}, bp: {} };
}

function backfillKey(date: string, metric: BackfillMetric): string {
  return `${date}|${metric}`;
}

/** Convert the backfill state into per-date SI value maps, ready to save. Each
 *  filled cell becomes a measurement at its date — through the SAME validated
 *  save path as the draft (SI conversion, range check). A weight/waist entry is
 *  a single metric; a BP entry is a paired systolic_bp + diastolic_bp committed
 *  together (only when the pair is complete + in-range via `bpPairReady`).
 *  Invalid / empty / half-entered values are dropped. Whether each resulting
 *  metric INSERTs or routes to a correction (occupied slot) is decided later by
 *  `routeTasksToSaves` against live history. Exported for unit testing. */
export function vitalsBackfillsToTasks(
  backfills: BackfillState,
  unitFor: (metric: BackfillMetric) => UnitSystem,
): SaveTask[] {
  const byDate = new Map<string, Record<string, number>>();
  const ensure = (date: string) => {
    const v = byDate.get(date) ?? {};
    byDate.set(date, v);
    return v;
  };
  for (const [key, typed] of Object.entries(backfills.simple)) {
    if (typed === '') continue;
    const sep = key.indexOf('|');
    const date = key.slice(0, sep);
    const metric = key.slice(sep + 1) as BackfillMetric;
    if (metric !== 'weight' && metric !== 'waist') continue;
    const display = unitFor(metric);
    if (validateTypedValue(metric, typed, display).error) continue;
    const n = parseLocalisedNumber(typed);
    if (n == null) continue;
    ensure(date)[metric] = toCanonicalValue(metric, n, display);
  }
  for (const [date, pair] of Object.entries(backfills.bp)) {
    // BP is atomic — only commit a complete, in-range sys/dia pair. mmHg has no
    // SI conversion (stored as-is), matching the draft-column BP commit.
    if (!bpPairReady(pair.sys, pair.dia)) continue;
    const values = ensure(date);
    values.systolic_bp = parseLocalisedNumber(pair.sys)!;
    values.diastolic_bp = parseLocalisedNumber(pair.dia)!;
  }
  return Array.from(byDate.entries()).map(([date, values]) => ({ date, values }));
}

// ── Component ───────────────────────────────────────────────────────────

export function StartingInfoVitals({
  inputs, vitalsHistory, unitSystem, isLoggedIn, onSave, onCorrectValue,
  onFieldChange, formStage, onAutoFocusEmail, unitOverrides, onToggleFieldUnit,
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

  const [draft, setDraft] = useState<DraftRow>(emptyDraft);
  // Typed values for empty weight/waist/BP cells in existing date columns.
  const [backfills, setBackfills] = useState<BackfillState>(emptyBackfills);
  const [activeCell, setActiveCell] = useState<string | null>(null);

  // Backfilling a PAST date deliberately does NOT mirror into inputs[field]
  // (unlike the draft column, which is today's reading): the suggestions engine
  // reads the *latest* value from inputs[field], and a historical backfill must
  // not override it. Backfills persist only through `commit`'s save below.
  const setBackfillValue = (date: string, metric: BackfillMetric, typed: string) => {
    setBackfills(prev => {
      const simple = { ...prev.simple };
      if (typed === '') delete simple[backfillKey(date, metric)];
      else simple[backfillKey(date, metric)] = typed;
      return { ...prev, simple };
    });
  };
  // Backfill a historical BP slot. systolic/diastolic edit independently but
  // commit as one pair (the bpPairReady gate in vitalsBackfillsToTasks).
  const setBackfillBp = (date: string, which: 'sys' | 'dia', typed: string) => {
    setBackfills(prev => {
      const bp = { ...prev.bp };
      const cur = bp[date] ?? { sys: '', dia: '' };
      const next = { ...cur, [which]: typed };
      if (next.sys === '' && next.dia === '') delete bp[date];
      else bp[date] = next;
      return { ...prev, bp };
    });
  };

  // Pre-populate the weight/waist draft from `inputs[field]` (guest typed a
  // value, reloaded → it lives in localStorage → inputs[field]) and re-render
  // it in the active display unit on a unit toggle. Same pattern the old row
  // used. BP isn't pre-populated here (its inputs round-trip below).
  useEffect(() => {
    const wU = fieldUnit('weightKg');
    const formatted = inputs.weightKg != null ? formatDisplayValue('weight', inputs.weightKg, wU) : '';
    setDraft(d => d.weight === formatted ? d : { ...d, weight: formatted });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputs.weightKg, unitOverrides.weightKg, unitSystem]);
  useEffect(() => {
    const wU = fieldUnit('waistCm');
    const formatted = inputs.waistCm != null ? formatDisplayValue('waist', inputs.waistCm, wU) : '';
    setDraft(d => d.waist === formatted ? d : { ...d, waist: formatted });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputs.waistCm, unitOverrides.waistCm, unitSystem]);

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

  // Draft value setters mirror into inputs[field] (SI) so suggestions + guest
  // persistence stay live.
  const setSimpleDraft = (metric: 'weight' | 'waist', typed: string) => {
    const field: keyof HealthInputs = metric === 'weight' ? 'weightKg' : 'waistCm';
    setDraft(d => ({ ...d, [metric]: typed }));
    const display = fieldUnit(field as 'weightKg' | 'waistCm');
    const { error } = validateTypedValue(metric, typed, display);
    if (typed === '' || error) { onFieldChange(field, undefined); return; }
    const n = parseLocalisedNumber(typed);
    onFieldChange(field, n == null ? undefined : toCanonicalValue(metric, n, display));

    // Weight only: continue the height → weight → email focus chain.
    if (metric === 'weight' && onAutoFocusEmail && !focusedEmailRef.current && !error && n != null) {
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

  const setBpDraft = (which: 'sys' | 'dia', typed: string) => {
    setDraft(d => ({ ...d, [which]: typed }));
    const n = parseLocalisedNumber(typed);
    if (which === 'sys') onFieldChange('systolicBp', n != null && n >= BP_SYS_MIN && n <= BP_SYS_MAX ? n : undefined);
    else onFieldChange('diastolicBp', n != null && n >= BP_DIA_MIN && n <= BP_DIA_MAX ? n : undefined);
  };

  // Validation of the whole draft + backfills + any filled value (blocks save
  // while bad).
  const draftValid = useMemo(() => {
    const wOk = draft.weight === '' || !validateTypedValue('weight', draft.weight, fieldUnit('weightKg')).error;
    const waOk = draft.waist === '' || !validateTypedValue('waist', draft.waist, fieldUnit('waistCm')).error;
    const bpEmpty = draft.sys === '' && draft.dia === '';
    // BP is atomic: a partially-filled pair (one field blank, or a mid-typed
    // out-of-range value) is NOT savable. bpPairReady centralises that gate.
    const bpOk = bpEmpty || bpPairReady(draft.sys, draft.dia);

    // Backfilled empty cells: validity is derived from the same
    // `vitalsBackfillsToTasks` fold that `commit` uses — it drops every
    // empty/invalid/out-of-range entry, so a SIMPLE backfill is OK iff every
    // non-empty weight/waist cell survives the fold (one source of truth, no
    // inline key re-parse). BP is atomic and validated separately: a half-typed
    // pair must block save, so `anyBpHalf` gates it directly. (BP's surviving
    // values would cancel on both sides of a simple-count equality, so they're
    // excluded from the fold here by passing only `simple`.)
    const nonEmptySimple = Object.values(backfills.simple).filter(v => v !== '').length;
    const survivingSimple = vitalsBackfillsToTasks(
      { simple: backfills.simple, bp: {} },
      metric => fieldUnit(metric === 'weight' ? 'weightKg' : 'waistCm'),
    ).reduce((n, t) => n + Object.keys(t.values).length, 0);
    const anyBpHalf = Object.values(backfills.bp).some(
      p => (p.sys !== '' || p.dia !== '') && !bpPairReady(p.sys, p.dia),
    );
    const backfillOk = survivingSimple === nonEmptySimple && !anyBpHalf;
    const anyBackfill = nonEmptySimple > 0 || Object.keys(backfills.bp).length > 0;

    const anyFilled = draft.weight !== '' || draft.waist !== '' || !bpEmpty || anyBackfill;
    return { ok: wOk && waOk && bpOk && backfillOk, anyFilled };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, backfills, unitOverrides, unitSystem]);

  const [saving, setSaving] = useState(false);

  const commit = async () => {
    if (!isLoggedIn || saving || !draftValid.ok || !draftValid.anyFilled) return;
    const values: Record<string, number> = {};
    if (draft.weight !== '') {
      const n = parseLocalisedNumber(draft.weight);
      if (n != null) values.weight = toCanonicalValue('weight', n, fieldUnit('weightKg'));
    }
    if (draft.waist !== '') {
      const n = parseLocalisedNumber(draft.waist);
      if (n != null) values.waist = toCanonicalValue('waist', n, fieldUnit('waistCm'));
    }
    // Only ever commit BP as a complete, in-range pair (never a half-entry).
    if (bpPairReady(draft.sys, draft.dia)) {
      values.systolic_bp = parseLocalisedNumber(draft.sys)!;
      values.diastolic_bp = parseLocalisedNumber(draft.dia)!;
    }

    // Backfilled empty cells → one task per past date. Combine with the draft
    // task and route them all through `routeTasksToSaves`: a slot that's still
    // empty INSERTs; a slot that already holds an active value (rare two-device
    // race) routes through the SAME `onCorrectValue` append-to-correct flow the
    // blood-test matrix + click-to-edit use (new active row + old row flipped to
    // `entered-in-error`, `corrects_id` set) — never a 409-and-clear, never a
    // mutation. For BP a collision corrects the existing paired value at that
    // date (sys and dia each route independently).
    const tasks: SaveTask[] = vitalsBackfillsToTasks(
      backfills,
      metric => fieldUnit(metric === 'weight' ? 'weightKg' : 'waistCm'),
    );
    if (Object.keys(values).length > 0) tasks.push({ date: draft.date, values });

    if (tasks.length === 0) return;
    setSaving(true);
    try {
      const { failed } = await routeTasksToSaves(tasks, vitalsHistory, onSave, onCorrectValue);
      // Preserve the user's typed values if any correction failed so they can
      // retry — don't clear the draft/backfills out from under them.
      if (failed) return;
      // Clear mirror so the legacy global save doesn't re-pick these up.
      onFieldChange('weightKg', undefined);
      onFieldChange('waistCm', undefined);
      onFieldChange('systolicBp', undefined);
      onFieldChange('diastolicBp', undefined);
      setDraft(emptyDraft());
      setBackfills(emptyBackfills());
      setActiveCell(null);
    } finally {
      setSaving(false);
    }
  };

  // Auto-save on blur / Enter (500ms debounce so tab-between-cells doesn't
  // fire mid-edit). Mirrors the blood-test matrix's scheduleMatrixSave.
  const debounce = useDebouncedSave(500);
  const commitRef = useRef(commit);
  commitRef.current = commit;
  const scheduleSave = () => {
    if (!draftValid.ok || !draftValid.anyFilled || !isLoggedIn) return;
    debounce.schedule(() => { void commitRef.current(); });
  };
  const flushSave = () => {
    if (!draftValid.ok || !draftValid.anyFilled || !isLoggedIn) { debounce.cancel(); return; }
    debounce.commit(() => { void commitRef.current(); });
  };

  return (
    <div className="bt-timeline bt-vitals-card">
      <div className="bt-timeline-body">
        <div ref={scrollRef} className="bt-timeline-scroll">
          <div className="bt-timeline-scroll-inner" style={{ '--bt-col-count': colCount } as React.CSSProperties}>
            {/* Header row — Metric | dates… | draft | Trend */}
            <div className="bt-row bt-header-row">
              <div className="bt-cell-name bt-cell-header">Metric</div>
              {columns.map((c, i) => {
                if (c.kind === 'draft') {
                  return <DraftDateCell key="draft" date={draft.date}
                                        onChange={date => setDraft(d => ({ ...d, date }))}
                                        ariaLabel="Choose draft date"/>;
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
                            value={draft[row.metric]}
                            placeholder="—"
                            wrapperClass={`bt-cell-input bt-cell-draft${formStage === 2 && row.metric === 'weight' && inputs.weightKg === undefined ? ' field-attention' : ''}`}
                            active={activeCell === cellId}
                            onChange={v => setSimpleDraft(row.metric, v)}
                            onFocus={() => setActiveCell(cellId)}
                            onBlur={() => { setActiveCell(null); scheduleSave(); }}
                            onKeyDown={e => { blockBadNumericKeys(e); if (e.key === 'Enter') { e.preventDefault(); flushSave(); } }}
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
                        const bfKey = backfillKey(c.col.date, row.metric);
                        const cellId = `${c.col.date}.${row.metric}`;
                        return (
                          <BackfillCell
                            key={cellId}
                            metric={row.metric}
                            display={display}
                            value={backfills.simple[bfKey] ?? ''}
                            pinned={isPinned}
                            active={activeCell === cellId}
                            onChange={val => setBackfillValue(c.col.date, row.metric, val)}
                            onFocus={() => setActiveCell(cellId)}
                            onBlur={() => { setActiveCell(null); scheduleSave(); }}
                            onEnter={flushSave}
                          />
                        );
                      }
                      return (
                        <ValueCell
                          key={`${c.col.date}.${row.metric}`}
                          metric={row.metric}
                          display={display}
                          sex={sex}
                          siValue={v}
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
                      return (
                        <BpInputCell
                          key="draft.bp"
                          sys={draft.sys}
                          dia={draft.dia}
                          previewStatus={bpStatus(parseLocalisedNumber(draft.sys), parseLocalisedNumber(draft.dia), age)}
                          onSysChange={v => setBpDraft('sys', v)}
                          onDiaChange={v => setBpDraft('dia', v)}
                          onEnter={flushSave}
                          // Only auto-save when focus LEAVES the whole BP cell
                          // (not when moving systolic ↔ diastolic). Without
                          // this, leaving the systolic field scheduled a save
                          // that fired mid-edit and cleared the draft under the
                          // user — the "focus jumped + wrong value" symptom.
                          onCellExit={scheduleSave}
                        />
                      );
                    }
                    const isPinned = colIdx === columns.length - 2;
                    if (c.col.sys == null || c.col.dia == null) {
                      // Empty BP slot → click-to-input, reusing the SAME guarded
                      // dual sys/dia component as the draft column (one source of
                      // truth for the 542e811 blur/half-pair guards). Commits a
                      // paired systolic_bp + diastolic_bp at this past date via
                      // the validated save path.
                      const bp = backfills.bp[c.col.date] ?? { sys: '', dia: '' };
                      return (
                        <BpInputCell
                          key={`${c.col.date}.bp`}
                          sys={bp.sys}
                          dia={bp.dia}
                          previewStatus={bpStatus(parseLocalisedNumber(bp.sys), parseLocalisedNumber(bp.dia), age)}
                          pinned={isPinned}
                          backfill
                          onSysChange={v => setBackfillBp(c.col.date, 'sys', v)}
                          onDiaChange={v => setBackfillBp(c.col.date, 'dia', v)}
                          onEnter={flushSave}
                          onCellExit={scheduleSave}
                        />
                      );
                    }
                    const status = bpStatus(c.col.sys, c.col.dia, age);
                    return (
                      <div key={`${c.col.date}.bp`} className={`bt-cell-value${isPinned ? ' bt-cell-pinned' : ''}`}>
                        <span className="bt-value-num bt-value-num--bp num">{c.col.sys}/{c.col.dia}</span>
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
      </div>
    </div>
  );
}

// ── BP input cell — dual sys/dia input in one column ─────────────────────
// ONE guarded BP input shared by the draft column (today's reading) AND the
// historical backfill cells (a past empty BP slot). Both need the exact same
// 542e811 guards: the sibling-blur suppression (`blurLeavesCell`) so tabbing
// systolic → diastolic doesn't fire a mid-edit save, and a commit gated on a
// complete in-range pair (`bpPairReady`, applied by the caller's save fold).
// `backfill`/`pinned` only swap the wrapper classes so it matches the
// surrounding empty-cell vs draft-cell styling.

function BpInputCell({
  sys, dia, previewStatus, onSysChange, onDiaChange, onEnter, onCellExit, pinned, backfill,
}: {
  sys: string;
  dia: string;
  previewStatus: Status;
  onSysChange: (v: string) => void;
  onDiaChange: (v: string) => void;
  onEnter: () => void;
  /** Fires only when focus leaves the whole BP cell (not systolic ↔ diastolic). */
  onCellExit: () => void;
  /** 2nd-from-right column highlight (matches BatchDateCell pinning). */
  pinned?: boolean;
  /** Style as an empty-slot backfill cell rather than the draft column. */
  backfill?: boolean;
}) {
  const cellRef = useRef<HTMLDivElement>(null);
  const onKey: React.KeyboardEventHandler<HTMLInputElement> = (e) => {
    blockBadNumericKeys(e);
    if (e.key === 'Enter') { e.preventDefault(); onEnter(); }
  };
  // A blur to the sibling sys/dia input keeps focus inside the cell — don't
  // save. Only schedule a save when focus actually exits the cell, so the
  // value can't clear under the user while they tab from systolic to diastolic.
  const onBlur: React.FocusEventHandler<HTMLInputElement> = (e) => {
    if (blurLeavesCell(e.relatedTarget as HTMLElement | null, cellRef.current)) onCellExit();
  };
  const wrapperClass = backfill
    ? `bt-cell-backfill${pinned ? ' bt-cell-pinned' : ''}`
    : 'bt-cell-value bt-cell-input bt-cell-draft';
  return (
    <div ref={cellRef} className={wrapperClass}>
      <div className="bt-vitals-bp-inputs">
        <input className="bt-input" inputMode="numeric" placeholder="sys" size={1}
               value={sys} onChange={e => onSysChange(e.target.value)} onKeyDown={onKey} onBlur={onBlur}/>
        <span className="bt-vitals-bp-sep">/</span>
        <input className="bt-input" inputMode="numeric" placeholder="dia" size={1}
               value={dia} onChange={e => onDiaChange(e.target.value)} onKeyDown={onKey} onBlur={onBlur}/>
      </div>
      <div className="bt-cell-foot">
        <span className={`bt-status-tick bt-status-${previewStatus ?? 'none'}`}/>
      </div>
    </div>
  );
}
