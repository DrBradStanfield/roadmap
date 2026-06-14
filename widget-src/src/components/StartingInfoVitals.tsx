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
import {
  type Status,
  blockBadNumericKeys,
  validateTypedValue,
} from '../lib/blood-test-cell';
import { useScrollToRightOnMount } from '../lib/useScrollToRightOnMount';
import { useDebouncedSave } from '../lib/useDebouncedSave';
import { Sparkline, ValueCell, BatchDateCell } from './BloodTestTimeline';
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
  onCorrectValue?: (oldId: string, newValueSI: number) => Promise<{ ok: true } | { ok: false; reason: 'conflict' | 'not_found' | 'error' }>;
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
  const [activeCell, setActiveCell] = useState<string | null>(null);

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
    if (which === 'sys') onFieldChange('systolicBp', n != null && n >= 60 && n <= 250 ? n : undefined);
    else onFieldChange('diastolicBp', n != null && n >= 40 && n <= 150 ? n : undefined);
  };

  // Validation of the whole draft + any filled value (blocks save while bad).
  const draftValid = useMemo(() => {
    const wOk = draft.weight === '' || !validateTypedValue('weight', draft.weight, fieldUnit('weightKg')).error;
    const waOk = draft.waist === '' || !validateTypedValue('waist', draft.waist, fieldUnit('waistCm')).error;
    const sysN = parseLocalisedNumber(draft.sys), diaN = parseLocalisedNumber(draft.dia);
    const bpEmpty = draft.sys === '' && draft.dia === '';
    const bpOk = bpEmpty || (sysN != null && diaN != null && sysN >= 60 && sysN <= 250 && diaN >= 40 && diaN <= 150);
    const anyFilled = draft.weight !== '' || draft.waist !== '' || !bpEmpty;
    return { ok: wOk && waOk && bpOk, anyFilled };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, unitOverrides, unitSystem]);

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
    const sysN = parseLocalisedNumber(draft.sys), diaN = parseLocalisedNumber(draft.dia);
    if (sysN != null && diaN != null) { values.systolic_bp = sysN; values.diastolic_bp = diaN; }
    if (Object.keys(values).length === 0) return;
    setSaving(true);
    try {
      await onSave(draft.date, values);
      // Clear mirror so the legacy global save doesn't re-pick these up.
      onFieldChange('weightKg', undefined);
      onFieldChange('waistCm', undefined);
      onFieldChange('systolicBp', undefined);
      onFieldChange('diastolicBp', undefined);
      setDraft(emptyDraft());
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
                        return <div key={`${c.col.date}.${row.metric}`} className={`bt-cell-value${isPinned ? ' bt-cell-pinned' : ''}`}>{' '}</div>;
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
                        <BpDraftCell
                          key="draft.bp"
                          sys={draft.sys}
                          dia={draft.dia}
                          previewStatus={bpStatus(parseLocalisedNumber(draft.sys), parseLocalisedNumber(draft.dia), age)}
                          onSysChange={v => setBpDraft('sys', v)}
                          onDiaChange={v => setBpDraft('dia', v)}
                          onEnter={flushSave}
                          onBlur={() => scheduleSave()}
                        />
                      );
                    }
                    const isPinned = colIdx === columns.length - 2;
                    if (c.col.sys == null || c.col.dia == null) {
                      return <div key={`${c.col.date}.bp`} className={`bt-cell-value${isPinned ? ' bt-cell-pinned' : ''}`}>{' '}</div>;
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

// ── BP draft cell — dual sys/dia input in one column ─────────────────────

function BpDraftCell({ sys, dia, previewStatus, onSysChange, onDiaChange, onEnter, onBlur }: {
  sys: string;
  dia: string;
  previewStatus: Status;
  onSysChange: (v: string) => void;
  onDiaChange: (v: string) => void;
  onEnter: () => void;
  onBlur: () => void;
}) {
  const onKey: React.KeyboardEventHandler<HTMLInputElement> = (e) => {
    blockBadNumericKeys(e);
    if (e.key === 'Enter') { e.preventDefault(); onEnter(); }
  };
  return (
    <div className="bt-cell-value bt-cell-input bt-cell-draft">
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
