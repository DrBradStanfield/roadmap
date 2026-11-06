// The phone's My data rows (US-62 AC8), the iPhone's layout (ValueRow.swift):
// the name with "target · date" under it, the recent trend, and the latest
// value with the previous one in brackets over its unit. A tap opens the
// value's page (ValuePage). Desktop keeps the grids.

import { useId, useMemo } from 'react';
import {
  type ApiMeasurement,
  type CellUnit,
  type Comparator,
  type GradeStatus,
  type Grading,
  type MetricType,
  type RowTargetPlan,
  BLOOD_TEST_METRICS,
  METRIC_LABELS,
  METRIC_TO_FIELD,
  cellLabel,
  gradeWords,
  labSeriesRows,
  limitText,
  limitUngraded,
  pressureStatus,
  recentTrend,
  rowTarget,
  valueStatus,
  LIMIT_NOT_GRADED,
} from '@roadmap/health-core';
import { savedCellText, trendGeometry } from '../lib/blood-test-cell';
import { monthYear, pressureReadings, readingsOf, type DayReading } from '../lib/my-data-rows';
import { SectionIcon, type SectionKey } from './icons';
import type { ApiLabValue } from '../lib/api-types';

/** What a row opens: a core metric, the blood pressure, or a lab test's series (`labSlotKey`). */
export type ValueSubject = { kind: 'core'; metric: MetricType } | { kind: 'bp' } | { kind: 'lab'; seriesKey: string };

/** The core blood tests, in the grid's order (PSA is asked under prostate screening). */
export const BLOOD_ROWS = BLOOD_TEST_METRICS.filter(m => m !== 'psa' && METRIC_TO_FIELD[m]) as MetricType[];

/** The iPhone's line colours (MetricChart.swift palette, light), so a trend reads the same on both. */
const TINT: Record<string, string> = {
  weight: '#AF52DE', waist: '#5856D6', blood_pressure: '#FF3B30', hba1c: '#D07A00', ldl: '#007AFF',
  apob: '#2E9ED2', total_cholesterol: '#2A9BB0', hdl: '#2CA84B', triglycerides: '#B28F00',
  creatinine: '#A2845E', lpa: '#B2598C', diastolic_bp: '#D37A70',
};
const LAB_TINT = '#6680A6';
/** A metric's line colour on its row and its page's chart; a lab test's (null) is one shared slate. */
export const tintOf = (metric: string | null) => (metric && TINT[metric]) || LAB_TINT;

/** Everything the rows and value pages read to grade and print a value. */
export interface RowContext {
  grading: Grading;
  plan: RowTargetPlan | null;
  /** The unit a core metric shows in: its own toggle, Lp(a)'s three-way control, else the page's. */
  unitOf: (metric: MetricType) => CellUnit;
}

/** A pressure as the grid prints it: "128/82". */
export const pressureText = (r: DayReading) => `${halfText(r.value, r.comparator)}/${halfText(r.dia!.value, r.dia!.comparator)}`;
/** One half: a whole number, or a limit with its symbol, rounded away from its band ("< 125"). */
const halfText = (v: number, comparator?: Comparator) => (comparator ? limitText(v, 0, comparator) : String(Math.round(v)));

interface RowModel {
  subject: ValueSubject;
  label: string;
  target: string | null;
  day: string | null;
  latest: string | null;
  previous: string | null;
  unit: string;
  trend: number[];
  /** Which trend points were printed as a limit: hollow, off the line (US-12 AC20). */
  trendLimits?: boolean[];
  /** Said beside a latest value the plan cannot grade (`LIMIT_NOT_GRADED`). */
  note?: string;
  tint: string;
  status: GradeStatus;
  /** The metric the grade is read for (`gradeWords`). */
  graded: string;
}

/** A row's trend points, and which were printed as a limit. */
function trendOf(readings: DayReading[], isLimit = (r: DayReading) => !!r.comparator): Pick<RowModel, 'trend' | 'trendLimits'> {
  const recent = recentTrend(readings);
  return { trend: recent.map(r => r.value), trendLimits: recent.map(isLimit) };
}

/** A blood pressure day is a limit when either half was printed as one, as the desktop vitals trend reads it (US-12 AC20a). */
const pressureLimit = (r: DayReading) => !!r.comparator || !!r.dia?.comparator;

function coreRow(metric: MetricType, history: ApiMeasurement[], ctx: RowContext): RowModel {
  const unit = ctx.unitOf(metric);
  const readings = readingsOf(history, metric);
  const [latest, previous] = readings;
  const status = latest ? valueStatus(metric, latest.value, ctx, latest.comparator) : null;
  return {
    subject: { kind: 'core', metric },
    label: METRIC_LABELS[metric] ?? metric,
    target: rowTarget(metric, unit, ctx.grading, ctx.plan)?.bare ?? null,
    day: latest?.day ?? null,
    latest: latest ? savedCellText(metric, latest.value, unit, latest.comparator) : null,
    previous: previous ? savedCellText(metric, previous.value, unit, previous.comparator) : null,
    unit: cellLabel(metric, unit),
    ...trendOf(readings),
    ...(latest && limitUngraded(metric, status, ctx, latest) ? { note: LIMIT_NOT_GRADED } : {}),
    tint: TINT[metric] ?? LAB_TINT,
    status,
    graded: metric,
  };
}

function pressureRow(history: ApiMeasurement[], ctx: RowContext): RowModel {
  const readings = pressureReadings(history);
  const [latest, previous] = readings;
  const status = latest ? pressureStatus(latest, ctx) : null;
  return {
    subject: { kind: 'bp' },
    label: 'Blood Pressure',
    target: rowTarget('blood_pressure', 'si', ctx.grading, ctx.plan)?.bare ?? null,
    day: latest?.day ?? null,
    latest: latest ? pressureText(latest) : null,
    previous: previous ? pressureText(previous) : null,
    unit: 'mmHg',
    ...trendOf(readings, pressureLimit),
    ...(latest && limitUngraded('blood_pressure', status, ctx, latest) ? { note: LIMIT_NOT_GRADED } : {}),
    tint: TINT.blood_pressure,
    status,
    graded: 'blood_pressure',
  };
}

/** The lab tests beyond the core ones, one row per series, as the grid groups them (health-core's `labSeriesRows`). */
function labRows(labValues: ApiLabValue[]): RowModel[] {
  return labSeriesRows(labValues).map(({ seriesKey, label, target, latest, previous, unit, trend, trendLimits }): RowModel => ({
    subject: { kind: 'lab', seriesKey }, label, target, day: latest.day, latest: latest.value, previous, unit,
    trend, ...(trendLimits && { trendLimits }), tint: LAB_TINT, status: null, graded: '',
  }));
}

/** A value's recent days as a small line, as the iPhone draws it (ValueRow.swift
 *  `Sparkline`): the metric's colour, a fading fill under it and a dot on the
 *  newest day. Nothing for fewer than two days. A day printed as a limit
 *  (`limits[i]`) is a hollow dot at its bound, off the line (US-12 AC20). */
export function RowTrend({ points, limits, tint, width = 44, height = 18 }: { points: number[]; limits?: boolean[]; tint: string; width?: number; height?: number }) {
  const fill = `md-fill${useId().replace(/:/g, '')}`; // one gradient per row
  if (points.length < 2) return <span className="md-row-trend" aria-hidden="true">{' '}</span>;
  const { coords, exact, line, area } = trendGeometry(points, limits, width, height, height);
  const [lastX, lastY] = coords[coords.length - 1];
  const lastLimit = !!limits?.[coords.length - 1];
  return (
    <svg className="md-row-trend" width={width} height={height} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={fill} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={tint} stopOpacity="0.25"/>
          <stop offset="1" stopColor={tint} stopOpacity="0"/>
        </linearGradient>
      </defs>
      {area && <path d={area} fill={`url(#${fill})`}/>}
      {area && <path d={line} fill="none" stroke={tint} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>}
      {exact.length === 1 && exact[0] !== coords[coords.length - 1] && <circle cx={exact[0][0]} cy={exact[0][1]} r="1.75" fill={tint}/>}
      {coords.map(([x, y], i) => limits?.[i] && i < coords.length - 1 && (
        <circle key={i} className="md-trend-limit" cx={x} cy={y} r="1.75" fill="none" stroke={tint} strokeWidth="1"/>
      ))}
      <circle className={lastLimit ? 'md-trend-limit' : undefined} cx={lastX} cy={lastY} r="2" fill={lastLimit ? 'none' : tint} stroke={lastLimit ? tint : undefined} strokeWidth={lastLimit ? 1 : undefined}/>
    </svg>
  );
}

/** One row. Screen readers hear "81, previous 74": brackets alone say nothing out loud. */
function MetricRow({ row, onOpen }: { row: RowModel; onOpen: (subject: ValueSubject) => void }) {
  const meta = [row.target, row.day && monthYear(row.day)].filter(Boolean).join(' · ');
  return (
    <li>
      <button type="button" className="md-row" onClick={() => onOpen(row.subject)}>
        <span className="md-row-name">
          <span className="md-row-label">{row.label}</span>
          {meta && <span className="md-row-meta">{meta}</span>}
        </span>
        <RowTrend points={row.trend} limits={row.trendLimits} tint={row.tint}/>
        <span className="md-row-reading">
          {row.latest ? (
            <>
              <span className="md-row-value" aria-hidden="true">
                <span className={`md-row-latest md-status-${row.status ?? 'none'}`} title={row.note}>{row.latest}</span>
                {row.previous && <span className="md-row-prev"> ({row.previous})</span>}
              </span>
              <span className="hr-sr-only">{[row.latest, gradeWords(row.status, row.graded) ?? row.note, row.previous && `previous ${row.previous}`].filter(Boolean).join(', ')}</span>
              <span className="md-row-unit">{row.unit}</span>
            </>
          ) : <span className="md-row-add">Add</span>}
        </span>
      </button>
    </li>
  );
}

function RowSection({ title, icon, action, rows, onOpen, children }: { title: string; icon: SectionKey; action?: React.ReactNode; rows: RowModel[]; onOpen: (s: ValueSubject) => void; children?: React.ReactNode }) {
  return (
    <section className="md-section" aria-label={title}>
      {/* The title, and on its right the section's own action (Upload lab results, Brad 2026-11-02). */}
      <div className="md-section-head">
        <h3 className="health-section-title md-section-title"><SectionIcon section={icon}/>{title}</h3>
        {action}
      </div>
      <ul className="md-rows">
        {rows.map(row => <MetricRow key={row.subject.kind === 'lab' ? row.subject.seriesKey : row.subject.kind === 'bp' ? 'bp' : row.subject.metric} row={row} onOpen={onOpen}/>)}
      </ul>
      {children}
    </section>
  );
}

export function VitalsRows({ history, ctx, onOpen, withoutWeight }: { history: ApiMeasurement[]; ctx: RowContext; onOpen: (s: ValueSubject) => void; withoutWeight?: boolean }) {
  // The weight asked beside the height shows there alone (US-62 AC13).
  const rows = [...(withoutWeight ? [] : [coreRow('weight', history, ctx)]), coreRow('waist', history, ctx), pressureRow(history, ctx)];
  return <RowSection title="Vitals" icon="vitals" rows={rows} onOpen={onOpen}/>;
}

export function BloodTestRows({ history, labValues, ctx, onOpen, action, children }: {
  history: ApiMeasurement[]; labValues: ApiLabValue[]; ctx: RowContext; onOpen: (s: ValueSubject) => void; action?: React.ReactNode; children?: React.ReactNode;
}) {
  const labs = useMemo(() => labRows(labValues), [labValues]);
  const rows = [...BLOOD_ROWS.map(m => coreRow(m, history, ctx)), ...labs];
  return <RowSection title="Blood tests" icon="bloodTests" action={action} rows={rows} onOpen={onOpen}>{children}</RowSection>;
}
