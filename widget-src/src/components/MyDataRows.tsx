// My health's rows (US-62 AC8, AC21), the iPhone's layout (ValueRow.swift):
// the name with "target · date" under it, the recent trend, and the latest
// value with the previous one in brackets over its unit. A tap opens the
// value's page (ValuePage). Phone and desktop alike.

import { memo, useId, useLayoutEffect, useRef, useState } from 'react';
import { type ApiMeasurement, BLOOD_TEST_METRICS, METRIC_LABELS, METRIC_TO_FIELD } from '@roadmap/health-core/mappings';
import { type CellUnit, cellLabel } from '@roadmap/health-core/cell-unit';
import type { EgfrPoint, WhtrPoint } from '@roadmap/health-core/plan';
import type { StatTile } from '@roadmap/health-core/stat-tiles';
import { type Comparator, limitText, LIMIT_NOT_GRADED } from '@roadmap/health-core/lab-limits';
import { type GradeStatus, gradeWords, limitUngraded, pressureStatus, valueStatus } from '@roadmap/health-core/row-grade';
import { type Grading, type RowTargetPlan, rowTarget } from '@roadmap/health-core/row-target';
import { type MetricType, WHTR_TARGET } from '@roadmap/health-core/units';
import { labSeriesRows } from '@roadmap/health-core/lab-series';
import { recentTrend } from '@roadmap/health-core/recent-trend';
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
function trendOf(readings: DayReading[], isLimit = (r: DayReading) => !!r.comparator): Pick<RowModel, 'trend' | 'trendLimits'> {
  const recent = recentTrend(readings);
  return { trend: recent.map(r => r.value), trendLimits: recent.map(isLimit) };
}

/** A blood pressure day is a limit when either half was printed as one, as the desktop vitals trend reads it (US-12 AC20a). */
const pressureLimit = (r: DayReading) => !!r.comparator || !!r.dia?.comparator;

export function coreRow(metric: MetricType, history: ApiMeasurement[], ctx: RowContext): RowModel {
  const unit = ctx.unitOf(metric);
  const readings = readingsOf(history, metric);
  const [latest, previous] = readings;
  const status = latest ? valueStatus(metric, latest.value, ctx, latest.comparator) : null;
  return {
    subject: { kind: 'core', metric },
    label: METRIC_LABELS[metric] ?? metric,
    target: rowTarget(metric, unit, ctx.grading, ctx.plan)?.[latest ? 'bare' : 'alone'] ?? null,
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
    target: rowTarget('blood_pressure', 'si', ctx.grading, ctx.plan)?.[latest ? 'bare' : 'alone'] ?? null,
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
/** The lab eGFR's series key (`labSlotKey`): its own row, page and correction (US-73 AC7). */
export const LAB_EGFR = 'egfr';
/** A row or page subject that is the lab's eGFR series. */
export const isLabEgfr = (s: ValueSubject) => s.kind === 'lab' && s.seriesKey === LAB_EGFR;

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
export function RowTrend({ points, limits, tint, width = TREND_WIDTH, height = 18, band }: { points: number[]; limits?: boolean[]; tint: string; width?: number; height?: number; band?: TrendBand }) {
  const fill = `md-fill${useId().replace(/:/g, '')}`; // one gradient per row
  if (points.length < 2) return <span className="md-row-trend" aria-hidden="true">{' '}</span>;
  const { top = 0, height: drawn = height } = band ?? {};
  const { coords, exact, line, area } = trendGeometry(points, limits, width, drawn, drawn);
  const [lastX, lastY] = coords[coords.length - 1];
  const lastLimit = !!limits?.[coords.length - 1];
  return (
    <svg className="md-row-trend" width={width} height={height} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={fill} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={tint} stopOpacity="0.125"/>
          <stop offset="1" stopColor={tint} stopOpacity="0"/>
        </linearGradient>
      </defs>
      <g transform={`translate(0,${top})`}>
      {area && <path d={area} fill={`url(#${fill})`}/>}
      {area && <path d={line} fill="none" stroke={tint} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>}
      {exact.length === 1 && exact[0] !== coords[coords.length - 1] && <circle cx={exact[0][0]} cy={exact[0][1]} r="1.75" fill={tint}/>}
      {coords.map(([x, y], i) => limits?.[i] && i < coords.length - 1 && (
        <circle key={i} className="md-trend-limit" cx={x} cy={y} r="1.75" fill="none" stroke={tint} strokeWidth="1"/>
      ))}
      <circle className={lastLimit ? 'md-trend-limit' : undefined} cx={lastX} cy={lastY} r="2" fill={lastLimit ? 'none' : tint} stroke={lastLimit ? tint : undefined} strokeWidth={lastLimit ? 1 : undefined}/>
      </g>
    </svg>
  );
}

/** A row trend's width, the iPhone's too (ValueRow.swift `trendWidth`); 44 below 390px wide (styles.css). */
const TREND_WIDTH = 56;
/** Where a row's trend is drawn inside its box: from `top`, `height` tall. */
type TrendBand = { top: number; height: number };
/** The band between the title's cap height (`capTop`) and the date line's baseline, capped at
 *  0.8 x the width and centred there, so a title wrapped at large text never draws a tall spike
 *  (US-62 AC8a). None while the two are not yet a band wider than the line's 2px padding each
 *  side (a measurement still settling): the trend then fills its box. The iPhone's twin is
 *  ValueRow.trendBand. */
export function trendBand(capTop: number, baseline: number, width = TREND_WIDTH): TrendBand | undefined {
  if (!(baseline - capTop > 4)) return undefined;
  const height = Math.min(baseline - capTop, 0.8 * width);
  return { top: capTop + (baseline - capTop - height) / 2, height };
}

let pen: CanvasRenderingContext2D | null | undefined;
/** Where `text`'s words are inked, in viewport px: its first line's cap height and its last
 *  line's baseline, read from the text's line boxes and its font's metrics. Nothing is added to
 *  the text, so nothing can wrap onto a line of its own. Null where the browser cannot say. */
function inkOf(text: Element): { capTop: number; baseline: number } | null {
  const range = document.createRange();
  range.selectNodeContents(text);
  const lines = [...(range.getClientRects?.() ?? [])].filter(line => line.width > 0);
  if (!lines.length) return null;
  pen ??= document.createElement('canvas').getContext('2d');
  if (!pen) return null;
  const font = getComputedStyle(text);
  pen.font = `${font.fontStyle} ${font.fontWeight} ${font.fontSize} ${font.fontFamily}`;
  const { fontBoundingBoxDescent: descent, actualBoundingBoxAscent: cap } = pen.measureText('H');
  return { capTop: lines[0].bottom - descent - cap, baseline: lines[lines.length - 1].bottom - descent };
}

/** One row. Screen readers hear "81, previous 74": brackets alone say nothing out loud. */
const MetricRow = memo(function MetricRow({ row, onOpen }: { row: RowModel; onOpen: (subject: ValueSubject, from?: Element) => void }) {
  const meta = [row.target, row.day && monthYear(row.day)].filter(Boolean).join(' · ');
  // The trend is as tall as the name block and drawn over its ink, the title's cap height to the
  // date line's baseline, as the iPhone's row (US-62 AC8a).
  const name = useRef<HTMLSpanElement>(null);
  const [fit, setFit] = useState<{ width: number; height: number; band?: TrendBand }>();
  const measured = useRef<string>();
  useLayoutEffect(() => {
    const block = name.current;
    if (!block || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const box = block.getBoundingClientRect();
      const label = block.querySelector('.md-row-label'), meta = block.querySelector('.md-row-meta');
      const top = label && inkOf(label), bottom = meta && inkOf(meta);
      const width = block.parentElement?.querySelector('.md-row-trend')?.getBoundingClientRect().width || TREND_WIDTH; // the CSS column's
      const band = top && bottom ? trendBand(top.capTop - box.top, bottom.baseline - box.top, width) : undefined;
      const next = box.height ? { width, height: box.height, band } : undefined;
      const key = JSON.stringify(next);
      if (key === measured.current) return; // the same measurement renders nothing
      measured.current = key;
      setFit(next);
    };
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(block);
    // A web font swapping in moves the ink without always resizing the block (#1002 R2).
    let live = true;
    document.fonts?.ready.then(() => { if (live) measure(); });
    return () => { live = false; watch.disconnect(); };
  }, []);
  return (
    <li>
      <button type="button" className="md-row" onClick={e => onOpen(row.subject, e.currentTarget)} data-row={row.key ?? subjectKey(row.subject)}>
        <span className="md-row-name" ref={name}>
          <span className="md-row-label">{row.label}</span>
          {meta && <span className="md-row-meta">{meta}</span>}
        </span>
        <RowTrend points={row.trend} limits={row.trendLimits} tint={row.tint} width={fit?.width} height={fit?.height} band={fit?.band}/>
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
});

/** A subject's stable key: a row's React key and its page's tile map key (ValuePage). */
export const subjectKey = (s: ValueSubject) => (s.kind === 'lab' ? `lab:${s.seriesKey}` : s.kind === 'bp' ? 'bp' : s.metric);

/** A list of rows, the iPhone's ValueRow list. */
export function MetricRows({ rows, onOpen }: { rows: RowModel[]; onOpen: (s: ValueSubject, from?: Element) => void }) {
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
export function egfrRow(series: EgfrPoint[], tile: StatTile | undefined, current: { day: string; source: 'lab' | 'calculated' } | null, labEgfrHeld: boolean): RowModel | null {
  if (!tile || !current) return null;
  const at = series.find(p => p.day === current.day && p.source === current.source);
  const older = series.filter(p => p.day < current.day);
  const lab = current.source === 'lab';
  return {
    key: 'egfr',
    subject: lab && labEgfrHeld ? { kind: 'lab', seriesKey: LAB_EGFR } : { kind: 'core', metric: 'creatinine' },
    label: 'eGFR', target: [tile.status?.label, lab ? 'Lab result' : 'Calculated'].filter(Boolean).join(' · '),
    day: current.day, latest: tile.value, previous: older[0] ? String(older[0].value) : null, unit: tile.unit,
    // The plan's point and up to six before it, as the iPhone draws it (TopicPlan.swift HealthPage.egfr: prefix(7)).
    trend: [...(at ? [at] : []), ...older].slice(0, 7).map(p => p.value).reverse(),
    tint: TINT.creatinine, status: tileGrade(tile), graded: '',
  };
}
