// A value's page (US-62 AC10), opened from its My health row: the
// chart, the full history, Add and Correct. Built on what exists: the chart
// is the history panel's (lazy, as the lightbox loads it), each saved value
// is the grids' saved-value editor (ValueCell), a core Add goes through the
// grids' save (`SaveTask` → HealthTool → matrix-save), and a lab test's Add
// is the grid's own AddLabTest. No save path of its own.

import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { type ApiMeasurement, METRIC_LABELS } from '@roadmap/health-core/mappings';
import { type CellUnit, cellFromSI, cellLabel, cellText, cellToSI } from '@roadmap/health-core/cell-unit';
import type { MetricType } from '@roadmap/health-core/units';
import type { StatTile } from '@roadmap/health-core/stat-tiles';
import { PRESSURE_ORDER, pressureInverted } from '@roadmap/health-core/validation';
import { localDay } from '@roadmap/health-core/merge';
import { groupLabValues, savedLabText } from '@roadmap/health-core/lab-series';
import { limitText, LIMIT_NOT_GRADED } from '@roadmap/health-core/lab-limits';
import { limitUngraded, pressureStatus, valueStatus } from '@roadmap/health-core/row-grade';
import { rowTarget } from '@roadmap/health-core/row-target';
import { blockBadNumericKeys, blockNonIntegerKeys, bpSysAdvance, readTypedValue, sameAsSaved, savedCellText, validateTypedValue } from '../lib/blood-test-cell';
import { activeRowIndex, slotOf, type CorrectFn, type Refused, type SaveTask } from '../lib/matrix-save';
import { pressureReadings, readingsOf, type DayReading } from '../lib/my-data-rows';
import { chartTimestamp, formatShortDate } from '../lib/constants';
import { getShownErase } from '../lib/roadmap-data';
import { withClaim } from '../lib/sync-claim';
import { ErrorBoundary } from './ErrorBoundary';
import { scrollToTop } from '../lib/reveal';
import { useIsMobile } from '../lib/useIsMobile';
import { useAutoAdvance } from '../lib/useAutoAdvance';
import { ValueCell, saveErrorText, useLiveRegion } from './BloodTestTimeline';
import { AddLabTest } from './AddLabTest';
import { LAB_EGFR, isLabEgfr, pressureText, subjectKey, tintOf, type RowContext, type ValueSubject } from './MyDataRows';
import { PlanTile } from './PlanCards';
import type { ApiLabValue } from '../lib/api-types';

// The chart library loads with the chart, never with the form (as the history lightbox loads it).
/** What the Add form says when the unit changed under typed text (US-05 AC2). */
const UNIT_CHANGED = 'The unit changed, so your value was not saved. Type it again in the new unit.';

const TimeSeriesChart = lazy(() => import('./HistoryPanel').then(m => ({ default: m.TimeSeriesChart })));
const MixedUnitsNote = lazy(() => import('./HistoryPanel').then(m => ({ default: m.MixedUnitsNote })));

interface ValuePageProps {
  subject: ValueSubject;
  /** The vitals and blood-test rows, as the grids read them. */
  history: ApiMeasurement[];
  labValues: ApiLabValue[];
  ctx: RowContext;
  /** The plan's tiles: each one's explainer shows on its row's page (US-62 AC26). */
  tiles: StatTile[];
  /** The grids' save: one task per cell, refused slots answered (matrix-save). */
  onSave: (tasks: SaveTask[], erase?: string) => Promise<Refused>;
  onCorrect?: CorrectFn;
  onLabAdded?: () => void;
  onClose: () => void;
  /** Opens another value's page: creatinine's and the lab eGFR's link to each other (US-73 AC7). */
  onOpen: (subject: ValueSubject) => void;
  /** Set while the Add form holds unsaved typing, so leaving can ask first. */
  dirtyRef: MutableRefObject<boolean>;
  /** A weight about to be added: the onboarding's answer, as the weight box gives it (US-62 AC13). */
  onWeightAnswered?: () => void;
}

/** Each tile's explainer on its row's page, by the page's subject (US-62 AC26; TopicPlan.swift
 *  PlanTiles.pages): protein follows weight, as its target does; non-HDL is total cholesterol less HDL. */
const TILE_PAGES: Record<string, string[]> = {
  weight: ['bmi', 'ibw', 'protein'], waist: ['whtr'], hba1c: ['hba1c'], creatinine: ['egfr'], 'lab:egfr': ['egfr'],
  apob: ['apoB'], ldl: ['ldl'], total_cholesterol: ['nonHdl'], lpa: ['lpa'],
};

export function ValuePage({ subject, history, labValues, ctx, tiles, onSave, onCorrect, onLabAdded, onClose, onOpen, dirtyRef, onWeightAnswered }: ValuePageProps) {
  const titleId = useId();
  const titleRef = useRef<HTMLHeadingElement>(null);
  // The page opens at its own top (Back), clear of the theme's sticky header, with its title
  // focused, so a screen reader starts here.
  const pageRef = useRef<HTMLElement>(null);
  useEffect(() => {
    scrollToTop(pageRef.current);
    titleRef.current?.focus({ preventScroll: true });
  }, []);
  const [say, messages] = useLiveRegion('md-page-messages');

  // The lab tests' series, grouped once: this page's, and whether the lab eGFR is held.
  const series = useMemo(() => groupLabValues(labValues).flatMap(g => g.series), [labValues]);
  const lab = subject.kind === 'lab' ? series.find(s => s.seriesKey === subject.seriesKey) : undefined;
  const metric = subject.kind === 'core' ? subject.metric : null;
  const unit = metric ? ctx.unitOf(metric) : 'si';
  const pageKey = subjectKey(subject);
  const pageTiles = (TILE_PAGES[pageKey] ?? []).flatMap(key => tiles.filter(t => t.key === key));
  // A lab eGFR can always be reached and corrected, whichever eGFR the row shows (US-73 AC7).
  const labEgfrHeld = series.some(s => s.seriesKey === LAB_EGFR);
  const label = subject.kind === 'bp' ? 'Blood Pressure' : metric ? METRIC_LABELS[metric] ?? metric : lab?.label ?? '';
  const latestLab = lab && labValues.find(v => v.id === lab.points[lab.points.length - 1].id);
  const target = subject.kind === 'bp' ? rowTarget('blood_pressure', 'si', ctx.grading, ctx.plan)
    : metric ? rowTarget(metric, unit, ctx.grading, ctx.plan)
    : latestLab ? rowTarget({ referenceLow: latestLab.referenceLow, referenceHigh: latestLab.referenceHigh }, 'si', null, null)
    : null;

  const readings: DayReading[] = subject.kind === 'bp' ? pressureReadings(history)
    : metric ? readingsOf(history, metric)
    : [...(lab?.points ?? [])].reverse().map(p => ({ day: p.recordedAt.slice(0, 10), id: p.id, value: p.value, comparator: p.comparator }));

  // The chart's points, oldest first, in the units shown; a pressure draws both halves.
  const charts = useMemo(() => {
    // A limit is a hollow dot at its bound, read with its symbol (US-12 AC20).
    const series = (rows: DayReading[], y: (r: DayReading) => number, limit?: (r: DayReading) => string) => [...rows].reverse()
      .map(r => ({ x: chartTimestamp(r.day), y: y(r), ...(r.comparator && limit ? { limit: limit(r) } : {}) }));
    // Each line in its row's colour (`tintOf`), as the iPhone's metric page draws it.
    // A pressure's line per half: each half is hollow where it alone was printed as a limit (US-12 AC20a).
    const half = (r: DayReading) => limitText(r.value, 0, r.comparator!);
    if (subject.kind === 'bp') return [
      { title: 'Systolic', data: series(readings, r => r.value, half), unit: 'mmHg', color: tintOf('blood_pressure') },
      { title: 'Diastolic', data: series(readings.map(r => ({ day: r.day, ...r.dia! })), r => r.value, half), unit: 'mmHg', color: tintOf('diastolic_bp') },
    ];
    if (metric) return [{ title: label, data: series(readings, r => cellFromSI(metric, r.value, unit), r => savedCellText(metric, r.value, unit, r.comparator)), unit: cellLabel(metric, unit), color: tintOf(metric) }];
    return lab && !lab.mixedUnits ? [{ title: label, data: series(readings, r => r.value, r => savedLabText(r.value, r.comparator)), unit: lab.unit, color: tintOf(null) }] : [];
  }, [history, labValues, subject, unit]);

  // Correct on a pressure fills the Add form with its day: a pressure is one reading, corrected whole.
  const [correcting, setCorrecting] = useState<DayReading | null>(null);

  // The page leads with the latest value, the iPhone's metric page (design review 2026-11-06).
  const unitOfPoint = (id: string) => (lab?.mixedUnits ? lab.points.find(p => p.id === id)?.unit : lab?.unit);
  const shownUnit = (r: DayReading) => (subject.kind === 'bp' ? 'mmHg' : metric ? cellLabel(metric, unit) : unitOfPoint(r.id));
  const latest = readings[0];
  const latestText = latest && (subject.kind === 'bp' ? pressureText(latest)
    : metric ? savedCellText(metric, latest.value, unit, latest.comparator) : savedLabText(latest.value, latest.comparator));
  // The ideal weight tile says the weight page's target: the line would say it twice.
  const targetShown = target?.bare && !pageTiles.some(t => t.key === 'ibw');
  const pointer = window.matchMedia?.('(pointer: fine)').matches ? 'Click' : 'Tap';
  // A phone has no Settings button: its Account tab holds the units (US-62 AC34).
  const unitsHome = useIsMobile() ? 'Account' : 'Settings';

  return (
    <section className="md-page" aria-labelledby={titleId} ref={pageRef}>
      <button type="button" className="md-back" onClick={onClose}>‹ Back</button>
      <h3 id={titleId} ref={titleRef} tabIndex={-1} className="health-section-title md-page-title">{label}</h3>
      {latest && (
        <p className="md-page-latest">
          <span className="md-page-latest-value">{latestText}</span> <span className="md-page-latest-unit">{shownUnit(latest)}</span>
          <span className="md-page-latest-day">{formatShortDate(latest.day)}</span>
        </p>
      )}
      {targetShown && <p className="md-page-target">{target.full}</p>}
      {pageTiles.length > 0 && <div className="stats-grid md-page-tiles">{pageTiles.map(tile => <PlanTile key={tile.key} tile={tile}/>)}</div>}
      {pageKey === 'creatinine' && labEgfrHeld && (
        <button type="button" className="md-foot-btn md-page-link" onClick={() => onOpen({ kind: 'lab', seriesKey: LAB_EGFR })}>Lab eGFR results</button>
      )}
      {isLabEgfr(subject) && (
        <button type="button" className="md-foot-btn md-page-link" onClick={() => onOpen({ kind: 'core', metric: 'creatinine' })}>Creatinine</button>
      )}

      {readings.length > 0 && (
        // A chart that cannot load (offline, its chunk refused) or throws while drawing says so in its place only (US-62 AC37).
        <ErrorBoundary feature="value_page_chart" fallback={
          <p className="md-page-empty">The chart could not load. Check your connection, then reload the page to see it.</p>
        }>
          <Suspense fallback={<p className="history-loading">Loading chart…</p>}>
            {lab?.mixedUnits && <MixedUnitsNote label={label} units={[...new Set(lab.points.map(p => p.unit))]}/>}
            {charts.map(c => <TimeSeriesChart key={c.title} title={c.title} showTitle={c.title !== label} data={c.data} unit={c.unit} color={c.color}/>)}
          </Suspense>
        </ErrorBoundary>
      )}

      <h4 className="md-page-subtitle">Add a value</h4>
      {subject.kind === 'lab'
        ? latestLab && <AddLabTest onAdded={onLabAdded ?? (() => {})} labValues={labValues} coreValues={history} onCorrect={onCorrect}
                                   preset={{ metricName: latestLab.metricName, unit: lab!.unit }} dirtyRef={dirtyRef}/>
        : <AddValue key={correcting?.id ?? 'new'} metric={metric} history={history} unit={unit} start={correcting}
                    onSave={onSave} say={say} onDone={() => setCorrecting(null)} dirtyRef={dirtyRef} onWeightAnswered={onWeightAnswered}/>}

      <h4 className="md-page-subtitle">History</h4>
      {readings.length === 0 ? <p className="md-page-empty">No values yet.</p> : (
        <ul className="md-history">
          {readings.map(r => (
            <li key={r.id} className="md-history-row">
              <span className="md-history-day">{formatShortDate(r.day)}</span>
              {subject.kind === 'bp' ? (
                <span className="md-history-bp">
                  <PressureValue reading={r} ctx={ctx}/>
                  <button type="button" className="md-history-correct" onClick={() => setCorrecting(r)}
                          aria-label={`Correct the reading of ${formatShortDate(r.day)}`}>Correct</button>
                </span>
              ) : metric ? (
                <CoreValue metric={metric} unit={unit} reading={r} ctx={ctx} onCorrect={onCorrect} say={say}/>
              ) : (
                <ValueCell value={r.value} comparator={r.comparator} unit={unitOfPoint(r.id)}
                           rowId={r.id} status={null} pinned={false} onCorrect={onCorrect} say={say}/>
              )}
            </li>
          ))}
        </ul>
      )}
      {metric && readings.length > 0 && <p className="md-page-hint">{pointer} a value to correct it.</p>}
      {subject.kind !== 'lab' && <p className="md-page-hint">To change units, use {unitsHome} or All results as a table.</p>}
      {messages}
    </section>
  );
}

/** A history row's core value: its grade, and the limit note only when the plan's rule leaves a
 *  limit ungraded, so the colour and the note always agree (US-12 AC21). */
function CoreValue({ metric, unit, reading, ctx, onCorrect, say }: {
  metric: MetricType; unit: CellUnit; reading: DayReading; ctx: RowContext; onCorrect?: CorrectFn; say: (m: string) => void;
}) {
  const status = valueStatus(metric, reading.value, ctx, reading.comparator);
  return <ValueCell metric={metric} display={unit} unit={cellLabel(metric, unit)} grading={ctx.grading} value={reading.value} comparator={reading.comparator} rowId={reading.id}
                    status={status} ungraded={limitUngraded(metric, status, ctx, reading)} pinned={false} onCorrect={onCorrect} say={say}/>;
}

/** A history row's blood pressure, coloured as graded; a limit pair the rule leaves ungraded says why. */
function PressureValue({ reading, ctx }: { reading: DayReading; ctx: RowContext }) {
  const status = pressureStatus(reading, ctx);
  const ungraded = limitUngraded('blood_pressure', status, ctx, reading);
  return (
    <span className={`md-history-value md-status-${status ?? 'none'}`} title={ungraded ? LIMIT_NOT_GRADED : undefined}>
      {pressureText(reading)} mmHg{ungraded && <span className="hr-sr-only">, {LIMIT_NOT_GRADED}</span>}
    </span>
  );
}

/** Add a core value or a blood pressure. One active value per (metric, day):
 *  a day that holds one already is corrected, never given a second (US-03
 *  AC2), through the `expected` row as the grids' cells name theirs; a day
 *  changed meanwhile on another device is refused (`changed`). */
function AddValue({ metric, history, unit, start, onSave, say, onDone, dirtyRef, onWeightAnswered }: {
  metric: MetricType | null; history: ApiMeasurement[]; unit: ReturnType<RowContext['unitOf']>; start: DayReading | null;
  onSave: (tasks: SaveTask[], erase?: string) => Promise<Refused>; say: (message: string) => void; onDone: () => void;
  /** True while the form holds text the person typed and has not saved. */
  dirtyRef: MutableRefObject<boolean>;
  onWeightAnswered?: () => void;
}) {
  const today = localDay(new Date());
  const [date, setDate] = useState(start?.day ?? today);
  const [text, setText] = useState(start ? String(Math.round(start.value)) : '');
  const [dia, setDia] = useState(start?.dia ? String(Math.round(start.dia.value)) : '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const claim = useRef(false); // seen by a second Add in the same render, as `saving` is not
  // Correct on a history row brings the form to that reading.
  const firstRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (start) firstRef.current?.focus(); }, []);
  // The systolic moves on to the diastolic as the grid's pressure cell does (US-02 AC6, AC6c; Codex R2, H71).
  const diaRef = useRef<HTMLInputElement>(null);
  const advanceToDia = useAutoAdvance();

  const metrics = metric ? [metric] : ['systolic_bp', 'diastolic_bp'] as const;
  const index = activeRowIndex(history);
  const rowsOn = (day: string) => metrics.map(m => index.get(slotOf(day, m)) ?? null);
  // The rows the form expects under its day, frozen when the person picks the
  // day or starts typing, as a grid cell's draft names its row (US-03 AC8): a
  // value another device writes there afterwards is never silently corrected;
  // the save answers `changed` and writes nothing.
  // The erase it began under travels with the save, so an erase landing
  // meanwhile refuses it (US-16 AC2a).
  const [seen, setSeen] = useState<{ day: string; rows: Array<ApiMeasurement | null>; erase: string } | null>(() =>
    start ? { day: start.day, rows: rowsOn(start.day), erase: getShownErase() } : null);
  const held = seen?.day === date ? seen.rows : rowsOn(date);
  const freeze = (day: string) => { if (seen?.day !== day) setSeen({ day, rows: rowsOn(day), erase: seen?.erase ?? getShownErase() }); };
  // The number typed is in the unit shown as it was typed. Another device's
  // unit choice (Lp(a)'s is in the record) would read it in the new one, so
  // the form clears and says so, as the grid's editor does (US-05 AC2).
  const [typedIn, setTypedIn] = useState<CellUnit | null>(null);
  const typed = (set: (v: string) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
    freeze(date); setTypedIn(prev => prev ?? unit); set(e.target.value); setError(null);
  };
  useEffect(() => {
    if (!typedIn || typedIn === unit) return;
    setText(''); setDia(''); setTypedIn(null);
    setError(UNIT_CHANGED);
  }, [unit]);
  dirtyRef.current = (text !== '' || dia !== '') && (!start || text !== String(Math.round(start.value)) || dia !== String(Math.round(start.dia?.value ?? NaN)));
  useEffect(() => () => { dirtyRef.current = false; }, []);
  const taken = held.some(Boolean);
  const takenText = !taken ? '' : metric ? `${savedCellText(metric, held[0]!.value, unit, held[0]!.comparator)} ${cellLabel(metric, unit)}`
    : held[0] && held[1] ? `${Math.round(held[0].value)}/${Math.round(held[1].value)} mmHg` : 'part of a reading';

  const parse = (): Record<string, number> | string => {
    if (!date || date > today) return 'Choose a day up to today.';
    if (metric) {
      const fault = text === '' ? 'Enter a value' : validateTypedValue(metric, text, unit).error;
      return fault ?? { [metric]: cellToSI(metric, readTypedValue(metric, text, unit)!, unit) };
    }
    const fault = (text === '' || dia === '' ? 'Enter both numbers' : null)
      ?? validateTypedValue('systolic_bp', text, 'si').error ?? validateTypedValue('diastolic_bp', dia, 'si').error;
    if (fault) return fault;
    const values = { systolic_bp: readTypedValue('systolic_bp', text, 'si')!, diastolic_bp: readTypedValue('diastolic_bp', dia, 'si')! };
    return pressureInverted(values.systolic_bp, values.diastolic_bp) ? PRESSURE_ORDER : values;
  };

  const add = () => withClaim(claim, async () => {
    const values = parse();
    if (typeof values === 'string') { setError(values); return; }
    setError(null);
    setSaving(true);
    const expected = Object.fromEntries(metrics.map((m, i) => [m, held[i]?.id ?? null]));
    // The same number again writes nothing (matrix-save's `sameAsSaved`), so say so.
    const unchanged = held.every((row, i) => {
      if (!row) return false;
      const m = metrics[i];
      return metric ? sameAsSaved(readTypedValue(m, text, unit)!, cellText(m, row.value, unit), values[m], row.value)
        : Math.round(row.value) === values[m];
    });
    // Before the save, as the weight box answers as it is typed: the step is counted when the save's
    // re-read raises the stage, and a refused save's re-read clears the answer (Codex R1, H71).
    if (metric === 'weight') onWeightAnswered?.();
    const refused = await onSave([{ date, values, expected, unit }], seen?.erase ?? getShownErase()).finally(() => setSaving(false));
    const [why] = refused.values();
    if (why) {
      setError(saveErrorText(why));
      // The form now shows what is there, so the next press is a deliberate correction of it.
      if (why === 'changed') setSeen({ day: date, rows: rowsOn(date), erase: seen?.erase ?? getShownErase() });
      return;
    }
    say(unchanged ? 'No change.' : taken ? 'Corrected.' : 'Added.');
    setText(''); setDia(''); setDate(today); setSeen(null); setTypedIn(null);
    dirtyRef.current = false;
    onDone();
  });

  return (
    <form className="md-add" noValidate onSubmit={e => { e.preventDefault(); void add(); }}>
      <label className="md-add-field">
        <span>Date</span>
        <input type="date" value={date} max={today} onChange={e => { setDate(e.target.value); freeze(e.target.value); setError(null); }}/>
      </label>
      {metric ? (
        <label className="md-add-field">
          <span>Value</span>
          <span className="md-add-input">
            <input type="text" inputMode="decimal" value={text} onKeyDown={blockBadNumericKeys} onChange={typed(setText)}/>
            <span className="md-add-unit">{cellLabel(metric, unit)}</span>
          </span>
        </label>
      ) : (
        <div className="md-add-field">
          <span>Reading</span>
          <span className="md-add-input">
            <input ref={firstRef} type="text" inputMode="numeric" aria-label="Systolic (top number)" value={text} onKeyDown={blockNonIntegerKeys}
                   onChange={e => {
                     typed(setText)(e);
                     const adv = bpSysAdvance(e.target.value);
                     advanceToDia(dia === '' && adv !== 'stay' ? { ambiguous: adv === 'defer', advance: () => diaRef.current?.focus() } : null);
                   }}/>
            <span aria-hidden="true">/</span>
            <input ref={diaRef} type="text" inputMode="numeric" aria-label="Diastolic (bottom number)" value={dia} onKeyDown={blockNonIntegerKeys}
                   onChange={typed(setDia)}/>
            <span className="md-add-unit">mmHg</span>
          </span>
        </div>
      )}
      {taken && <p className="md-add-note">This day has {takenText} already. Saving corrects it.</p>}
      {error && <p className="error-message" role="alert">{error}</p>}
      <button type="submit" className="md-add-save" disabled={saving}>{taken ? 'Save correction' : 'Add'}</button>
    </form>
  );
}
