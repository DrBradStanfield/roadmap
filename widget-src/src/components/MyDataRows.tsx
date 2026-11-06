// My health's rows (US-62 AC8, AC21), the iPhone's layout (ValueRow.swift):
// the name with "target · date" under it, the recent trend, and the latest
// value with the previous one in brackets over its unit. A tap opens the
// value's page (ValuePage). Phone and desktop alike.

import { useId } from 'react';
import {
  type ApiMeasurement,
  type CellUnit,
  type EgfrPoint,
  type StatTile,
  type WhtrPoint,
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
  WHTR_TARGET,
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

export interface RowModel {
  /** The row's own key where its subject is another's page (waist-to-height opens the waist's). */
  key?: string;
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
function trendOf(readings: DayReading[]): Pick<RowModel, 'trend' | 'trendLimits'> {
  const recent = recentTrend(readings);
  return { trend: recent.map(r => r.value), trendLimits: recent.map(r => !!r.comparator) };
}

export function coreRow(metric: MetricType, history: ApiMeasurement[], ctx: RowContext): RowModel {
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

export function pressureRow(history: ApiMeasurement[], ctx: RowContext): RowModel {
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
    trend: recentTrend(readings).map(r => r.value),
    ...(latest && limitUngraded('blood_pressure', status, ctx, latest) ? { note: LIMIT_NOT_GRADED } : {}),
    tint: TINT.blood_pressure,
    status,
    graded: 'blood_pressure',
  };
}

/** The lab tests beyond the core ones, one row per series, as the grid groups them (health-core's `labSeriesRows`). */
export function labRows(labValues: ApiLabValue[]): RowModel[] {
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
      <button type="button" className="md-row" onClick={() => onOpen(row.subject)} data-row={row.key ?? subjectKey(row.subject)}>
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

const subjectKey = (s: ValueSubject) => (s.kind === 'lab' ? `lab:${s.seriesKey}` : s.kind === 'bp' ? 'bp' : s.metric);

/** A list of rows, the iPhone's ValueRow list. */
export function MetricRows({ rows, onOpen }: { rows: RowModel[]; onOpen: (s: ValueSubject) => void }) {
  if (rows.length === 0) return null;
  return (
    <ul className="md-rows">
      {rows.map(row => <MetricRow key={row.key ?? subjectKey(row.subject)} row={row} onOpen={onOpen}/>)}
    </ul>
  );
}

/** A My health section (US-62 AC17): its title with its tinted symbol, the title line's
 *  own action on its right (Blood tests' upload), then what the section holds. */
export function TopicHeading({ title, icon, id, action }: { title: string; icon: SectionKey; id: string; action?: React.ReactNode }) {
  return (
    <div className="md-section-head mh-topic-head">
      <h3 className="health-section-title md-section-title" id={id} tabIndex={-1}><SectionIcon section={icon}/>{title}</h3>
      {action}
    </div>
  );
}

/** A plan tile's status as a row's grade: amber for attention, red for urgent (TopicPlan.swift PlanTiles.grade). */
const tileGrade = (tile: StatTile | undefined): GradeStatus =>
  tile?.status?.tone === 'urgent' ? 'bad' : tile?.status?.tone === 'attention' ? 'warn' : null;

/** Waist-to-height (US-62 AC21): health-core's series (waist over the current height), its
 *  target "Normal <0.5", graded by the plan's tile; it opens the waist page. None without a ratio. */
export function whtrRow(series: WhtrPoint[], tile: StatTile | undefined): RowModel | null {
  const [latest, previous] = series;
  if (!latest) return null;
  return {
    key: 'whtr', subject: { kind: 'core', metric: 'waist' }, label: 'Waist-to-height', target: WHTR_TARGET,
    day: latest.day, latest: latest.ratio.toFixed(2), previous: previous ? previous.ratio.toFixed(2) : null, unit: '',
    trend: recentTrend(series).map(p => p.ratio), tint: TINT.waist, status: tileGrade(tile), graded: 'waist',
  };
}

/** Weight, its target line the plan's BMI ("BMI 27.4"), else its own (US-62 AC21). */
export function weightRow(history: ApiMeasurement[], ctx: RowContext, bmi: StatTile | undefined): RowModel {
  const row = coreRow('weight', history, ctx);
  return bmi ? { ...row, target: `${bmi.label} ${bmi.value}` } : row;
}

/** Non-HDL when the plan works it out (its lipid marker's tile): it opens total cholesterol's page. */
export function nonHdlRow(tile: StatTile | undefined, total: RowModel): RowModel | null {
  if (!tile) return null;
  return {
    key: 'nonHdl', subject: total.subject, label: tile.label, target: tile.status?.label ?? null, day: total.day,
    latest: tile.value, previous: null, unit: tile.unit, trend: [], tint: TINT.total_cholesterol, status: tileGrade(tile), graded: '',
  };
}

/**
 * The one eGFR row (US-62 AC21, US-73 AC7): the plan's current eGFR, its tile's value
 * and status, on the day and from the source the plan used; the series gives only the
 * previous value and the trend. It opens the page of its source: the lab eGFR's, or
 * creatinine's. None without the plan's eGFR.
 */
export function egfrRow(series: EgfrPoint[], tile: StatTile | undefined, current: { day: string; source: 'lab' | 'calculated' } | null, labSeriesKey: string | null): RowModel | null {
  if (!tile || !current) return null;
  const at = series.find(p => p.day === current.day && p.source === current.source);
  const older = series.filter(p => p.day < current.day);
  const lab = current.source === 'lab';
  return {
    key: 'egfr',
    subject: lab && labSeriesKey ? { kind: 'lab', seriesKey: labSeriesKey } : { kind: 'core', metric: 'creatinine' },
    label: 'eGFR', target: [tile.status?.label, lab ? 'Lab result' : 'Calculated'].filter(Boolean).join(' · '),
    day: current.day, latest: tile.value, previous: older[0] ? String(older[0].value) : null, unit: tile.unit,
    trend: [...(at ? [at] : []), ...older].slice(0, 7).map(p => p.value).reverse(),
    tint: TINT.creatinine, status: tileGrade(tile), graded: '',
  };
}
