// Vitals (Weight, Waist, Blood Pressure) rendered as per-metric scrollable
// rows that visually match the BloodTestTimeline matrix. Each metric owns
// its own dates, so each row is its own mini-matrix with its own scroll.
//
// Reuses the existing `.bt-*` CSS classes from styles.css, the matrix's
// `Sparkline` component, and `NumericInputCell` for the draft input.
// Status thresholds (IBW for weight, WHtR < 0.5 for waist, BP < 120/80)
// live here because they depend on user demographics that the shared
// `statusOf` in `lib/blood-test-cell.ts` doesn't carry.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  type ApiMeasurement,
  type HealthInputs,
  type MetricType,
  type UnitSystem,
  toCanonicalValue,
  fromCanonicalValue,
  formatDisplayValue,
  getDisplayLabel,
  getDisplayRange,
  parseLocalisedNumber,
  calculateIBW,
} from '@roadmap/health-core';
import { MONTHS_SHORT } from '../lib/constants';
import { type Status, blockBadNumericKeys, validateTypedValue } from '../lib/blood-test-cell';
import { useScrollToRightOnMount } from '../lib/useScrollToRightOnMount';
import { Sparkline } from './BloodTestTimeline';

const MONTH_LABELS = MONTHS_SHORT.map(m => m.label);

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
   *  just that metric's display unit (kg ↔ lbs, cm ↔ inches). Same
   *  prop chain the blood-test matrix uses. */
  unitOverrides: Record<string, UnitSystem>;
  onToggleFieldUnit: (field: string) => void;
}

type SimpleMetric = {
  key: 'weight' | 'waist';
  metric: MetricType;
  label: string;
  field: keyof HealthInputs;
};

const SIMPLE_METRICS: SimpleMetric[] = [
  { key: 'weight', metric: 'weight',  label: 'Weight',               field: 'weightKg' },
  { key: 'waist',  metric: 'waist',   label: 'Waist\nCircumference', field: 'waistCm' },
];

// ── Status thresholds (user-demographic-dependent — live here, not in
// `lib/blood-test-cell.ts`, to keep that file scoped to lab metrics) ────

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

// Live preview from typed display-unit values (validates + canonicalises).
function previewSimpleStatus(metric: 'weight' | 'waist', typed: string, display: UnitSystem, heightCm?: number, sex?: 'male' | 'female'): Status {
  const n = parseLocalisedNumber(typed);
  if (n === undefined) return null;
  const si = toCanonicalValue(metric, n, display);
  return metric === 'weight' ? weightStatus(si, heightCm, sex) : waistStatus(si, heightCm);
}

// ── Date helpers ────────────────────────────────────────────────────────

function fmtDate(iso: string): { day: number; mon: string; yr: string } {
  const d = new Date(iso + 'T00:00');
  return {
    day: d.getDate(),
    mon: MONTH_LABELS[d.getMonth()],
    yr: String(d.getFullYear()).slice(-2),
  };
}
function todayIso(): string { return new Date().toISOString().slice(0, 10); }
function isoOnly(s: string): string { return s.slice(0, 10); }

// Group BP measurements by date — DB stores systolic + diastolic as two
// rows sharing a recorded_at, but the UI pairs them per cell.
type BpBatch = { date: string; sys?: number; dia?: number };
function groupBp(rows: ApiMeasurement[]): BpBatch[] {
  const map = new Map<string, BpBatch>();
  for (const r of rows) {
    if (r.metricType !== 'systolic_bp' && r.metricType !== 'diastolic_bp') continue;
    const date = isoOnly(r.recordedAt);
    if (!map.has(date)) map.set(date, { date });
    const b = map.get(date)!;
    if (r.metricType === 'systolic_bp') b.sys = r.value;
    else b.dia = r.value;
  }
  return Array.from(map.values())
    .filter(b => b.sys != null && b.dia != null)
    .sort((a, b) => a.date.localeCompare(b.date));
}

type SimpleBatch = { date: string; v: number };
function groupSimple(rows: ApiMeasurement[], metric: 'weight' | 'waist'): SimpleBatch[] {
  return rows
    .filter(r => r.metricType === metric)
    .map(r => ({ date: isoOnly(r.recordedAt), v: r.value }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ── Component ───────────────────────────────────────────────────────────

export function StartingInfoVitals({ inputs, vitalsHistory, unitSystem, isLoggedIn, onSave, onFieldChange, formStage, onAutoFocusEmail, unitOverrides, onToggleFieldUnit }: StartingInfoVitalsProps) {
  const heightCm = inputs.heightCm;
  const sex = inputs.sex;
  const age = useMemo(() => {
    if (!inputs.birthYear) return undefined;
    const now = new Date();
    const m = inputs.birthMonth ?? 1;
    let a = now.getFullYear() - inputs.birthYear;
    if (now.getMonth() + 1 < m || (now.getMonth() + 1 === m && now.getDate() < 1)) a -= 1;
    return a;
  }, [inputs.birthYear, inputs.birthMonth]);

  const ibwKg = useMemo(() => (heightCm && sex ? calculateIBW(heightCm, sex) : undefined), [heightCm, sex]);
  const waistTargetCm = useMemo(() => (heightCm ? heightCm * 0.5 : undefined), [heightCm]);
  const bpSysTarget = age != null && age >= 65 ? 130 : 120;

  // Reference labels in the user's display unit.
  const weightRef = ibwKg != null
    ? `Target: ${formatDisplayValue('weight', ibwKg, unitSystem)} ${getDisplayLabel('weight', unitSystem)}`
    : 'Set sex + height to see target';
  const waistRef = waistTargetCm != null
    ? `Target: <${formatDisplayValue('waist', waistTargetCm, unitSystem)} ${getDisplayLabel('waist', unitSystem)}`
    : 'Set height to see target';
  const bpRef = `Target: <${bpSysTarget}/80 mmHg`;

  // Memoised so typing in the draft doesn't refilter+resort the whole
  // history array on every keystroke. Inputs change only when the parent
  // pushes a new vitalsHistory.
  const weightHistory = useMemo(() => groupSimple(vitalsHistory, 'weight'), [vitalsHistory]);
  const waistHistory = useMemo(() => groupSimple(vitalsHistory, 'waist'), [vitalsHistory]);
  const bpHistory = useMemo(() => groupBp(vitalsHistory), [vitalsHistory]);

  return (
    // `bt-timeline` provides the matrix-wide CSS variables (--bt-name-w,
    // --bt-value-w, --bt-trend-w, ink colors, row min-height). Without it
    // the cells fall back to content-size — name column collapses to ~91px.
    <div className="bt-timeline bt-vitals-card">
      <VitalsSimpleRow
        key="weight"
        metric={SIMPLE_METRICS[0]}
        history={weightHistory}
        unitSystem={unitOverrides.weightKg ?? unitSystem}
        heightCm={heightCm}
        sex={sex}
        refLabel={weightRef}
        isLoggedIn={isLoggedIn}
        onSave={onSave}
        onFieldChange={onFieldChange}
        needsAttention={formStage === 2 && inputs.weightKg === undefined}
        inputId="weightKg"
        currentValue={inputs.weightKg}
        onAutoFocusEmail={onAutoFocusEmail}
        onToggleUnit={() => onToggleFieldUnit('weightKg')}
      />
      <VitalsSimpleRow
        key="waist"
        metric={SIMPLE_METRICS[1]}
        history={waistHistory}
        unitSystem={unitOverrides.waistCm ?? unitSystem}
        heightCm={heightCm}
        sex={sex}
        refLabel={waistRef}
        isLoggedIn={isLoggedIn}
        onSave={onSave}
        onFieldChange={onFieldChange}
        currentValue={inputs.waistCm}
        onToggleUnit={() => onToggleFieldUnit('waistCm')}
      />
      <VitalsBpRow
        history={bpHistory}
        bpStatusFn={(s, d) => bpStatus(s, d, age)}
        refLabel={bpRef}
        isLoggedIn={isLoggedIn}
        onSave={onSave}
        onFieldChange={onFieldChange}
      />
    </div>
  );
}

// ── Simple row (Weight / Waist) ─────────────────────────────────────────

interface SimpleRowProps {
  metric: SimpleMetric;
  history: SimpleBatch[];
  unitSystem: UnitSystem;
  heightCm?: number;
  sex?: 'male' | 'female';
  refLabel: string;
  isLoggedIn: boolean;
  onSave: (date: string, values: Record<string, number>) => Promise<void>;
  onFieldChange: (field: keyof HealthInputs, value: number | undefined) => void;
  /** Pulse the draft input to attract attention. Used at stage 2 for the
   *  weight row only (progressive-disclosure gate). */
  needsAttention?: boolean;
  /** Optional id on the draft input — gives the existing height-onChange
   *  in InputPanel a way to `focusById('weightKg')` after height entry. */
  inputId?: string;
  /** Current SI value from `inputs[field]` — used to pre-populate the
   *  draft on mount for guests so their value persists after reload. */
  currentValue?: number;
  /** Weight row only — continues the focus chain to the email field
   *  after a valid weight is entered. */
  onAutoFocusEmail?: () => void;
  /** Toggle the per-field display unit (kg ↔ lbs, cm ↔ inches). */
  onToggleUnit?: () => void;
}

function VitalsSimpleRow({ metric, history, unitSystem, heightCm, sex, refLabel, isLoggedIn, onSave, onFieldChange, needsAttention, inputId, currentValue, onAutoFocusEmail, onToggleUnit }: SimpleRowProps) {
  const sorted = useMemo(() => history.slice().sort((a, b) => a.date.localeCompare(b.date)), [history]);
  // Pre-populate the draft from `inputs[field]` if the user already has a
  // value (typical guest scenario: typed a weight, reloaded the page, the
  // value lives in localStorage → inputs[field] → here). Logged-in users
  // also benefit when they've previously mirrored a draft value.
  const [draft, setDraft] = useState<{ value: string; date: string }>(() => ({
    value: currentValue != null ? formatDisplayValue(metric.metric, currentValue, unitSystem) : '',
    date: todayIso(),
  }));
  const [saving, setSaving] = useState(false);
  const stripRef = useScrollToRightOnMount<HTMLDivElement>([sorted.length]);
  const focusedEmailRef = useRef(false);
  const focusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const last = sorted[sorted.length - 1];
  const lastStatus: Status = last
    ? (metric.key === 'weight' ? weightStatus(last.v, heightCm, sex) : waistStatus(last.v, heightCm))
    : null;
  const sparkPoints = sorted.map(r => fromCanonicalValue(metric.metric, r.v, unitSystem));

  const valid = useMemo(() => {
    const { error } = validateTypedValue(metric.metric, draft.value, unitSystem);
    if (error) return false;
    const n = parseLocalisedNumber(draft.value);
    return n != null;
  }, [draft.value, metric.metric, unitSystem]);

  // Mirror typed value back into `inputs[field]` (in SI) so the suggestions
  // engine sees the live draft AND so guest users' typed values persist
  // via the parent's localStorage auto-save. Undefined when invalid so we
  // don't fire suggestions on bogus values.
  const setDraftValue = (typed: string) => {
    setDraft(d => ({ ...d, value: typed }));
    const { error } = validateTypedValue(metric.metric, typed, unitSystem);
    if (error) { onFieldChange(metric.field, undefined); return; }
    const n = parseLocalisedNumber(typed);
    onFieldChange(metric.field, n == null ? undefined : toCanonicalValue(metric.metric, n, unitSystem));

    // Weight row only: continue the height → weight → email focus chain.
    // Mirrors the legacy logic at InputPanel.tsx:552 — only 2-3 digit
    // typed values trigger it; a 2-digit value that could still extend
    // to 3 (e.g., "8" → "80") waits 800ms before firing.
    if (onAutoFocusEmail && !focusedEmailRef.current && !error && n != null) {
      if (focusTimerRef.current) clearTimeout(focusTimerRef.current);
      const r = getDisplayRange(metric.metric, unitSystem);
      if (/^\d{2,3}$/.test(typed) && n >= r.min && n <= r.max) {
        const couldExtend = /^\d{2}$/.test(typed) && n * 10 <= r.max;
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

  // Sync draft.value from the SI source of truth (`currentValue` =
  // `inputs[field]`). Two cases this fires for:
  //   1. Hydration — guest reloads the page; localStorage populates
  //      `inputs[field]` *after* this component mounted, so the useState
  //      initializer read undefined. This effect catches the update.
  //   2. Per-field unit toggle — user clicks kg ↔ lbs; the same SI value
  //      must re-render in the new unit.
  // Typing the user enters round-trips through onFieldChange → inputs →
  // back here; the same-value guard makes that a no-op.
  useEffect(() => {
    const formatted = currentValue != null
      ? formatDisplayValue(metric.metric, currentValue, unitSystem)
      : '';
    setDraft(d => d.value === formatted ? d : { ...d, value: formatted });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentValue, unitSystem]);

  const commit = async () => {
    if (!valid || !isLoggedIn || saving) return;
    const n = parseLocalisedNumber(draft.value);
    if (n == null) return;
    const si = toCanonicalValue(metric.metric, n, unitSystem);
    setSaving(true);
    try {
      await onSave(draft.date, { [metric.metric]: si });
      setDraft({ value: '', date: todayIso() });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bt-vitals-row">
      {valid && isLoggedIn && (
        <button type="button" className="bt-vitals-save" onClick={commit} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      )}
      <div className="bt-row">
        <div className="bt-cell-name">
          <div className="bt-name-label">{metric.label}</div>
          {onToggleUnit ? (
            <button type="button" className="bt-unit-chip" onClick={onToggleUnit}
                    title={`Switch unit for ${metric.label.replace('\n', ' ')}`}>
              {getDisplayLabel(metric.metric, unitSystem)}
            </button>
          ) : (
            <span className="bt-unit-chip bt-unit-chip--static">{getDisplayLabel(metric.metric, unitSystem)}</span>
          )}
          <div className="bt-ref-label">{refLabel}</div>
        </div>
        <div className="bt-scroll-x bt-cell-strip" ref={stripRef}>
          <div className="bt-strip-inner">
            {sorted.map((r, i) => (
              <SimpleValueCell
                key={r.date}
                metric={metric}
                reading={r}
                status={metric.key === 'weight' ? weightStatus(r.v, heightCm, sex) : waistStatus(r.v, heightCm)}
                unitSystem={unitSystem}
                pinned={i === sorted.length - 1}
              />
            ))}
            <SimpleDraftCell
              metric={metric}
              value={draft.value}
              date={draft.date}
              unitSystem={unitSystem}
              heightCm={heightCm}
              sex={sex}
              onChangeValue={setDraftValue}
              onChangeDate={date => setDraft(d => ({ ...d, date }))}
              onEnter={commit}
              onBlur={commit}
              needsAttention={needsAttention}
              inputId={inputId}
            />
            <div className="bt-cell-trend">
              {sparkPoints.length >= 2 && <Sparkline points={sparkPoints}/>}
              <span className={`bt-status-tick bt-status-${lastStatus ?? 'none'}`}/>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SimpleValueCell({ metric, reading, status, unitSystem, pinned }: {
  metric: SimpleMetric;
  reading: SimpleBatch;
  status: Status;
  unitSystem: UnitSystem;
  pinned: boolean;
}) {
  const d = fmtDate(reading.date);
  const displayVal = formatDisplayValue(metric.metric, reading.v, unitSystem);
  return (
    <div className={`bt-cell-value${pinned ? ' bt-cell-pinned' : ''}`}>
      <span className="bt-date-day">{d.day} {d.mon}</span>
      <span className="bt-date-year">'{d.yr}</span>
      <span className="bt-value-num">{displayVal}</span>
      <div className="bt-cell-foot">
        <span className={`bt-status-tick bt-status-${status ?? 'none'}`}/>
      </div>
    </div>
  );
}

function SimpleDraftCell({ metric, value, date, unitSystem, heightCm, sex, onChangeValue, onChangeDate, onEnter, onBlur, needsAttention, inputId }: {
  metric: SimpleMetric;
  value: string;
  date: string;
  unitSystem: UnitSystem;
  heightCm?: number;
  sex?: 'male' | 'female';
  onChangeValue: (v: string) => void;
  onChangeDate: (date: string) => void;
  onEnter: () => void;
  onBlur: () => void;
  needsAttention?: boolean;
  inputId?: string;
}) {
  const previewStatus = previewSimpleStatus(metric.key, value, unitSystem, heightCm, sex);
  const { error } = validateTypedValue(metric.metric, value, unitSystem);
  const d = fmtDate(date);
  return (
    <div className={`bt-cell-value bt-cell-draft bt-cell-vitals-draft${needsAttention ? ' field-attention' : ''}`}>
      <span className="bt-date-day">{d.day} {d.mon}</span>
      <DateButton date={date} onChange={onChangeDate}/>
      <input
        id={inputId}
        type="text"
        inputMode="decimal"
        pattern="[0-9.,]*"
        size={1}
        className={`bt-input${error ? ' bt-input-error' : ''}`}
        value={value}
        placeholder="—"
        title={error ?? undefined}
        aria-label={`Enter ${metric.label.replace('\n', ' ')}`}
        onChange={e => onChangeValue(e.target.value)}
        onBlur={onBlur}
        onKeyDown={e => {
          blockBadNumericKeys(e);
          if (e.key === 'Enter') { e.preventDefault(); onEnter(); }
        }}
      />
      <div className="bt-cell-foot">
        {error
          ? <span className="bt-input-error-text">{error}</span>
          : <span className={`bt-status-tick bt-status-${previewStatus ?? 'none'}`}/>}
      </div>
    </div>
  );
}

// ── BP row (sys / dia paired by date) ────────────────────────────────────

interface BpRowProps {
  history: BpBatch[];
  bpStatusFn: (sys?: number | null, dia?: number | null) => Status;
  refLabel: string;
  isLoggedIn: boolean;
  onSave: (date: string, values: Record<string, number>) => Promise<void>;
  onFieldChange: (field: keyof HealthInputs, value: number | undefined) => void;
}

function VitalsBpRow({ history, bpStatusFn, refLabel, isLoggedIn, onSave, onFieldChange }: BpRowProps) {
  const sorted = history; // already sorted by groupBp
  const [draft, setDraft] = useState<{ sys: string; dia: string; date: string }>({ sys: '', dia: '', date: todayIso() });
  const [saving, setSaving] = useState(false);
  const stripRef = useScrollToRightOnMount<HTMLDivElement>([sorted.length]);

  const last = sorted[sorted.length - 1];
  const lastStatus = last ? bpStatusFn(last.sys, last.dia) : null;
  // Sparkline shows systolic trend (the more clinically actionable line).
  const sparkPoints = sorted.map(b => b.sys ?? 0);

  const sysNum = parseLocalisedNumber(draft.sys);
  const diaNum = parseLocalisedNumber(draft.dia);
  const valid = sysNum != null && diaNum != null
    && sysNum >= 60 && sysNum <= 250
    && diaNum >= 40 && diaNum <= 150;

  const setSys = (v: string) => {
    setDraft(d => ({ ...d, sys: v }));
    const n = parseLocalisedNumber(v);
    onFieldChange('systolicBp', n != null && n >= 60 && n <= 250 ? n : undefined);
  };
  const setDia = (v: string) => {
    setDraft(d => ({ ...d, dia: v }));
    const n = parseLocalisedNumber(v);
    onFieldChange('diastolicBp', n != null && n >= 40 && n <= 150 ? n : undefined);
  };

  const commit = async () => {
    if (!valid || !isLoggedIn || saving) return;
    setSaving(true);
    try {
      await onSave(draft.date, { systolic_bp: sysNum!, diastolic_bp: diaNum! });
      setDraft({ sys: '', dia: '', date: todayIso() });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bt-vitals-row">
      {valid && isLoggedIn && (
        <button type="button" className="bt-vitals-save" onClick={commit} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      )}
      <div className="bt-row">
        <div className="bt-cell-name">
          <div className="bt-name-label">Blood Pressure</div>
          <span className="bt-unit-chip bt-unit-chip--static">mmHg</span>
          <div className="bt-ref-label">{refLabel}</div>
        </div>
        <div className="bt-scroll-x bt-cell-strip" ref={stripRef}>
          <div className="bt-strip-inner">
            {sorted.map((b, i) => {
              const d = fmtDate(b.date);
              const status = bpStatusFn(b.sys, b.dia);
              const pinned = i === sorted.length - 1;
              return (
                <div key={b.date} className={`bt-cell-value${pinned ? ' bt-cell-pinned' : ''}`}>
                  <span className="bt-date-day">{d.day} {d.mon}</span>
                  <span className="bt-date-year">'{d.yr}</span>
                  <span className="bt-value-num bt-value-num--bp">{b.sys}/{b.dia}</span>
                  <div className="bt-cell-foot">
                    <span className={`bt-status-tick bt-status-${status ?? 'none'}`}/>
                  </div>
                </div>
              );
            })}
            <BpDraftCell
              sys={draft.sys}
              dia={draft.dia}
              date={draft.date}
              onSysChange={setSys}
              onDiaChange={setDia}
              onDateChange={date => setDraft(d => ({ ...d, date }))}
              previewStatus={bpStatusFn(sysNum, diaNum)}
              onEnter={commit}
              onBlur={commit}
            />
            <div className="bt-cell-trend">
              {sparkPoints.length >= 2 && <Sparkline points={sparkPoints}/>}
              <span className={`bt-status-tick bt-status-${lastStatus ?? 'none'}`}/>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function BpDraftCell({ sys, dia, date, onSysChange, onDiaChange, onDateChange, previewStatus, onEnter, onBlur }: {
  sys: string;
  dia: string;
  date: string;
  onSysChange: (v: string) => void;
  onDiaChange: (v: string) => void;
  onDateChange: (d: string) => void;
  previewStatus: Status;
  onEnter: () => void;
  onBlur: () => void;
}) {
  const d = fmtDate(date);
  const onKey: React.KeyboardEventHandler<HTMLInputElement> = (e) => {
    blockBadNumericKeys(e);
    if (e.key === 'Enter') { e.preventDefault(); onEnter(); }
  };
  return (
    <div className="bt-cell-value bt-cell-draft bt-cell-vitals-draft">
      <span className="bt-date-day">{d.day} {d.mon}</span>
      <DateButton date={date} onChange={onDateChange}/>
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

// ── Calendar-icon button that opens the native date picker ─────────────

function DateButton({ date, onChange }: { date: string; onChange: (d: string) => void }) {
  const ref = useRef<HTMLInputElement | null>(null);
  const open = () => {
    try { (ref.current as any)?.showPicker?.(); }
    catch { ref.current?.click(); }
  };
  const d = fmtDate(date);
  return (
    <button type="button" className="bt-vitals-date-btn" onClick={open} title="Click to change date">
      <span className="bt-date-year">'{d.yr}</span>
      <svg width="10" height="10" viewBox="0 0 16 16" fill="none" className="bt-vitals-date-icon" aria-hidden="true">
        <rect x="2" y="3" width="12" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.3"/>
        <line x1="2" y1="6.5" x2="14" y2="6.5" stroke="currentColor" strokeWidth="1.3"/>
        <line x1="5" y1="2" x2="5" y2="4.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
        <line x1="11" y1="2" x2="11" y2="4.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
      </svg>
      <input ref={ref} type="date" value={date} onChange={e => onChange(e.target.value)}
             className="bt-date-hidden-icon" aria-label="Choose date"/>
    </button>
  );
}

