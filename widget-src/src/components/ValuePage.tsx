// A value's page on a phone (US-62 AC10), opened from its My data row: the
// chart, the full history, Add and Correct. Built on what exists: the chart
// is the history panel's (lazy, as the lightbox loads it), each saved value
// is the grids' saved-value editor (ValueCell), a core Add goes through the
// grids' save (`SaveTask` → HealthTool → matrix-save), and a lab test's Add
// is the grid's own AddLabTest. No save path of its own.

import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState, type MutableRefObject } from 'react';
import {
  type ApiMeasurement,
  type CellUnit,
  type MetricType,
  METRIC_LABELS,
  PRESSURE_ORDER,
  cellFromSI,
  cellLabel,
  cellText,
  cellToSI,
  localDay,
  pressureInverted,
  rowTarget,
} from '@roadmap/health-core';
import { blockBadNumericKeys, blockNonIntegerKeys, readTypedValue, sameAsSaved, validateTypedValue } from '../lib/blood-test-cell';
import { activeRowIndex, slotOf, type CorrectFn, type Refused, type SaveTask } from '../lib/matrix-save';
import { pressureReadings, readingsOf, type DayReading } from '../lib/my-data-rows';
import { groupLabValues } from '../lib/lab-rows';
import { chartTimestamp, formatShortDate } from '../lib/constants';
import { getShownErase } from '../lib/roadmap-data';
import { ErrorBoundary } from './ErrorBoundary';
import { SAVE_ERRORS, ValueCell, useLiveRegion } from './BloodTestTimeline';
import { AddLabTest } from './AddLabTest';
import { pressureStatus, pressureText, tintOf, valueStatus, type RowContext, type ValueSubject } from './MyDataRows';
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
  /** The grids' save: one task per cell, refused slots answered (matrix-save). */
  onSave: (tasks: SaveTask[], erase?: string) => Promise<Refused>;
  onCorrect?: CorrectFn;
  onLabAdded?: () => void;
  onClose: () => void;
  /** Set while the Add form holds unsaved typing, so leaving can ask first. */
  dirtyRef: MutableRefObject<boolean>;
}

export function ValuePage({ subject, history, labValues, ctx, onSave, onCorrect, onLabAdded, onClose, dirtyRef }: ValuePageProps) {
  const titleId = useId();
  const titleRef = useRef<HTMLHeadingElement>(null);
  // The page opens with its title focused, so a screen reader starts here.
  useEffect(() => titleRef.current?.focus(), []);
  const [say, messages] = useLiveRegion('md-page-messages');

  const lab = subject.kind === 'lab'
    ? groupLabValues(labValues).flatMap(g => g.series).find(s => s.seriesKey === subject.seriesKey)
    : undefined;
  const metric = subject.kind === 'core' ? subject.metric : null;
  const unit = metric ? ctx.unitOf(metric) : 'si';
  const label = subject.kind === 'bp' ? 'Blood Pressure' : metric ? METRIC_LABELS[metric] ?? metric : lab?.label ?? '';
  const latestLab = lab && labValues.find(v => v.id === lab.points[lab.points.length - 1].id);
  const target = subject.kind === 'bp' ? rowTarget('blood_pressure', 'si', ctx.grading, ctx.plan)
    : metric ? rowTarget(metric, unit, ctx.grading, ctx.plan)
    : latestLab ? rowTarget({ referenceLow: latestLab.referenceLow, referenceHigh: latestLab.referenceHigh }, 'si', null, null)
    : null;

  const readings: DayReading[] = subject.kind === 'bp' ? pressureReadings(history)
    : metric ? readingsOf(history, metric)
    : [...(lab?.points ?? [])].reverse().map(p => ({ day: p.recordedAt.slice(0, 10), id: p.id, value: p.value }));

  // The chart's points, oldest first, in the units shown; a pressure draws both halves.
  const charts = useMemo(() => {
    const series = (rows: DayReading[], y: (r: DayReading) => number) => [...rows].reverse().map(r => ({ x: chartTimestamp(r.day), y: y(r) }));
    // Each line in its row's colour (`tintOf`), as the iPhone's metric page draws it.
    if (subject.kind === 'bp') return [
      { title: 'Systolic', data: series(readings, r => r.value), unit: 'mmHg', color: tintOf('blood_pressure') },
      { title: 'Diastolic', data: series(readings, r => r.dia!.value), unit: 'mmHg', color: tintOf('diastolic_bp') },
    ];
    if (metric) return [{ title: label, data: series(readings, r => cellFromSI(metric, r.value, unit)), unit: cellLabel(metric, unit), color: tintOf(metric) }];
    return lab && !lab.mixedUnits ? [{ title: label, data: series(readings, r => r.value), unit: lab.unit, color: tintOf(null) }] : [];
  }, [history, labValues, subject, unit]);

  // Correct on a pressure fills the Add form with its day: a pressure is one reading, corrected whole.
  const [correcting, setCorrecting] = useState<DayReading | null>(null);

  return (
    <section className="md-page" aria-labelledby={titleId}>
      <button type="button" className="md-back" onClick={onClose}>‹ My data</button>
      <h3 id={titleId} ref={titleRef} tabIndex={-1} className="md-page-title">{label}</h3>
      {target && target.bare && <p className="md-page-target">{target.full}</p>}

      {readings.length > 0 && (
        <ErrorBoundary>
          <Suspense fallback={<p className="history-loading">Loading chart…</p>}>
            {lab?.mixedUnits && <MixedUnitsNote label={label} units={[...new Set(lab.points.map(p => p.unit))]}/>}
            {charts.map(c => <TimeSeriesChart key={c.title} title={c.title} data={c.data} unit={c.unit} color={c.color}/>)}
          </Suspense>
        </ErrorBoundary>
      )}

      <h4 className="md-page-subtitle">Add a value</h4>
      {subject.kind === 'lab'
        ? latestLab && <AddLabTest onAdded={onLabAdded ?? (() => {})} labValues={labValues} onCorrect={onCorrect}
                                   preset={{ metricName: latestLab.metricName, unit: lab!.unit }} dirtyRef={dirtyRef}/>
        : <AddValue key={correcting?.id ?? 'new'} metric={metric} history={history} unit={unit} start={correcting}
                    onSave={onSave} say={say} onDone={() => setCorrecting(null)} dirtyRef={dirtyRef}/>}

      <h4 className="md-page-subtitle">History</h4>
      {readings.length === 0 ? <p className="md-page-empty">No values yet.</p> : (
        <ul className="md-history">
          {readings.map(r => (
            <li key={r.id} className="md-history-row">
              <span className="md-history-day">{formatShortDate(r.day)}</span>
              {subject.kind === 'bp' ? (
                <span className="md-history-bp">
                  <span className={`md-history-value md-status-${pressureStatus(r, ctx) ?? 'none'}`}>{pressureText(r)} mmHg</span>
                  <button type="button" className="md-history-correct" onClick={() => setCorrecting(r)}
                          aria-label={`Correct the reading of ${formatShortDate(r.day)}`}>Correct</button>
                </span>
              ) : metric ? (
                <ValueCell metric={metric} display={unit} grading={ctx.grading} value={r.value} rowId={r.id}
                           status={valueStatus(metric, r.value, ctx)} pinned={false} onCorrect={onCorrect} say={say}/>
              ) : (
                <ValueCell value={r.value} unit={lab?.mixedUnits ? lab.points.find(p => p.id === r.id)?.unit : undefined}
                           rowId={r.id} status={null} pinned={false} onCorrect={onCorrect} say={say}/>
              )}
            </li>
          ))}
        </ul>
      )}
      {metric && <p className="md-page-hint">Tap a value to correct it.</p>}
      {subject.kind !== 'lab' && <p className="md-page-hint">To change units, use About you or All results as a table.</p>}
      {messages}
    </section>
  );
}

/** Add a core value or a blood pressure. One active value per (metric, day):
 *  a day that holds one already is corrected, never given a second (US-03
 *  AC2), through the `expected` row as the grids' cells name theirs; a day
 *  changed meanwhile on another device is refused (`changed`). */
function AddValue({ metric, history, unit, start, onSave, say, onDone, dirtyRef }: {
  metric: MetricType | null; history: ApiMeasurement[]; unit: ReturnType<RowContext['unitOf']>; start: DayReading | null;
  onSave: (tasks: SaveTask[], erase?: string) => Promise<Refused>; say: (message: string) => void; onDone: () => void;
  /** True while the form holds text the person typed and has not saved. */
  dirtyRef: MutableRefObject<boolean>;
}) {
  const today = localDay(new Date());
  const [date, setDate] = useState(start?.day ?? today);
  const [text, setText] = useState(start ? String(Math.round(start.value)) : '');
  const [dia, setDia] = useState(start?.dia ? String(Math.round(start.dia.value)) : '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Correct on a history row brings the form to that reading.
  const firstRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (start) firstRef.current?.focus(); }, []);

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
  const takenText = !taken ? '' : metric ? `${cellText(metric, held[0]!.value, unit)} ${cellLabel(metric, unit)}`
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

  const add = async () => {
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
    const refused = await onSave([{ date, values, expected, unit }], seen?.erase ?? getShownErase());
    setSaving(false);
    const [why] = refused.values();
    if (why) {
      setError(SAVE_ERRORS[why]);
      // The form now shows what is there, so the next press is a deliberate correction of it.
      if (why === 'changed') setSeen({ day: date, rows: rowsOn(date), erase: seen?.erase ?? getShownErase() });
      return;
    }
    say(unchanged ? 'No change.' : taken ? 'Corrected.' : 'Added.');
    setText(''); setDia(''); setDate(today); setSeen(null); setTypedIn(null);
    dirtyRef.current = false;
    onDone();
  };

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
                   onChange={typed(setText)}/>
            <span aria-hidden="true">/</span>
            <input type="text" inputMode="numeric" aria-label="Diastolic (bottom number)" value={dia} onKeyDown={blockNonIntegerKeys}
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
