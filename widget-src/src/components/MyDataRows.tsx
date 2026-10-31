// The phone's My data rows (US-62 AC8), the iPhone's layout (ValueRow.swift):
// the name with "target · date" under it, the recent trend, and the latest
// value with the previous one in brackets over its unit. A tap opens the
// value's page (ValuePage). Desktop keeps the grids.

import { useMemo } from 'react';
import {
  type ApiMeasurement,
  type CellUnit,
  type Grading,
  type MetricType,
  type RowSubject,
  type RowTargetPlan,
  BLOOD_TEST_METRICS,
  METRIC_LABELS,
  METRIC_TO_FIELD,
  bpTargetFor,
  cellLabel,
  cellText,
  rowTarget,
} from '@roadmap/health-core';
import { formatLabValue, statusOf, type Status } from '../lib/blood-test-cell';
import { monthYear, pressureReadings, readingsOf, recentTrend, type DayReading } from '../lib/my-data-rows';
import { groupLabValues } from '../lib/lab-rows';
import { bpStatus, simpleStatus } from './StartingInfoVitals';
import type { ApiLabValue } from '../lib/api-types';

/** What a row opens: a core metric, the blood pressure, or a lab test's series (`labSlotKey`). */
export type ValueSubject = { kind: 'core'; metric: MetricType } | { kind: 'bp' } | { kind: 'lab'; seriesKey: string };

/** The core blood tests, in the grid's order (PSA is asked under prostate screening). */
export const BLOOD_ROWS = BLOOD_TEST_METRICS.filter(m => m !== 'psa' && METRIC_TO_FIELD[m]) as MetricType[];

/** The iPhone's line colours (MetricChart.swift palette, light), so a trend reads the same on both. */
const TINT: Record<string, string> = {
  weight: '#AF52DE', waist: '#5856D6', blood_pressure: '#FF3B30', hba1c: '#D07A00', ldl: '#007AFF',
  apob: '#2E9ED2', total_cholesterol: '#2A9BB0', hdl: '#2CA84B', triglycerides: '#B28F00',
  creatinine: '#A2845E', lpa: '#B2598C',
};
const LAB_TINT = '#6680A6';

/** Everything the rows and value pages read to grade and print a value. */
export interface RowContext {
  grading: Grading;
  plan: RowTargetPlan | null;
  /** The unit a core metric shows in: its own toggle, Lp(a)'s three-way control, else the page's. */
  unitOf: (metric: MetricType) => CellUnit;
}

/** A value's grade, as the grids colour it: the blood tests by their lines,
 *  weight and waist by the plan; none for a known minor's adult lines. */
export function valueStatus(metric: MetricType, si: number, { grading, plan }: RowContext): Status {
  if (metric === 'weight') return simpleStatus('weight', si, grading ? plan?.idealBodyWeight : undefined);
  if (metric === 'waist') return simpleStatus('waist', si, undefined, plan?.heightCm);
  return statusOf(metric, si, grading);
}

/** A pressure's grade against the plan's systolic target; none without a plan or for a known minor. */
export function pressureStatus(r: DayReading, { grading, plan }: RowContext): Status {
  return bpStatus(r.value, r.dia?.value, plan && grading ? bpTargetFor(plan.age) : undefined);
}

/** A pressure as the grid prints it: "128/82". */
export const pressureText = (r: DayReading) => `${Math.round(r.value)}/${Math.round(r.dia!.value)}`;

interface RowModel {
  subject: ValueSubject;
  label: string;
  target: string | null;
  day: string | null;
  latest: string | null;
  previous: string | null;
  unit: string;
  trend: number[];
  tint: string;
  status: Status;
}

function coreRow(metric: MetricType, history: ApiMeasurement[], ctx: RowContext): RowModel {
  const unit = ctx.unitOf(metric);
  const readings = readingsOf(history, metric);
  const [latest, previous] = readings;
  return {
    subject: { kind: 'core', metric },
    label: METRIC_LABELS[metric] ?? metric,
    target: rowTarget(metric, unit, ctx.grading, ctx.plan)?.bare ?? null,
    day: latest?.day ?? null,
    latest: latest ? cellText(metric, latest.value, unit) : null,
    previous: previous ? cellText(metric, previous.value, unit) : null,
    unit: cellLabel(metric, unit),
    trend: recentTrend(readings).map(r => r.value),
    tint: TINT[metric] ?? LAB_TINT,
    status: latest ? valueStatus(metric, latest.value, ctx) : null,
  };
}

function pressureRow(history: ApiMeasurement[], ctx: RowContext): RowModel {
  const readings = pressureReadings(history);
  const [latest, previous] = readings;
  return {
    subject: { kind: 'bp' },
    label: 'Blood Pressure',
    target: rowTarget('blood_pressure', 'si', ctx.grading, ctx.plan)?.bare ?? null,
    day: latest?.day ?? null,
    latest: latest ? pressureText(latest) : null,
    previous: previous ? pressureText(previous) : null,
    unit: 'mmHg',
    trend: recentTrend(readings).map(r => r.value),
    tint: TINT.blood_pressure,
    status: latest ? pressureStatus(latest, ctx) : null,
  };
}

/** The lab tests beyond the core ones, one row per series, as the grid groups them. */
function labRows(labValues: ApiLabValue[]): RowModel[] {
  const byId = new Map(labValues.map(v => [v.id, v]));
  return groupLabValues(labValues).flatMap(g => g.series).map((s): RowModel => {
    const readings = [...s.points].reverse().map(p => ({ day: p.recordedAt.slice(0, 10), id: p.id, value: p.value }));
    const [latest, previous] = readings;
    const printed = byId.get(latest.id);
    // A series in more than one unit draws no trend: one line would be a false one (US-21 AC3a).
    const sameUnit = !s.mixedUnits;
    const target: RowSubject = { referenceLow: printed?.referenceLow, referenceHigh: printed?.referenceHigh };
    return {
      subject: { kind: 'lab', seriesKey: s.seriesKey },
      label: s.label,
      target: rowTarget(target, 'si', null, null)?.bare ?? null,
      day: latest.day,
      latest: formatLabValue(latest.value),
      previous: previous && sameUnit ? formatLabValue(previous.value) : null,
      unit: s.unit,
      trend: sameUnit ? recentTrend(readings).map(r => r.value) : [],
      tint: LAB_TINT,
      status: null,
    };
  });
}

/** A value's recent days as a small line, as the iPhone draws it (ValueRow.swift
 *  `Sparkline`): the metric's colour, a fading fill under it and a dot on the
 *  newest day. Nothing for fewer than two days. */
export function RowTrend({ points, tint, width = 44, height = 18 }: { points: number[]; tint: string; width?: number; height?: number }) {
  if (points.length < 2) return <span className="md-row-trend" aria-hidden="true">{' '}</span>;
  const low = Math.min(...points), high = Math.max(...points);
  const span = high - low || 1;
  const pad = 2;
  const spot = (v: number, i: number) => [
    pad + (i / (points.length - 1)) * (width - pad * 2),
    height - pad - ((v - low) / span) * (height - pad * 2),
  ] as const;
  const coords = points.map(spot);
  const line = coords.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const [lastX, lastY] = coords[coords.length - 1];
  const area = `${line} L${(width - pad).toFixed(1)},${height} L${pad},${height} Z`;
  const fill = `md-fill-${tint.slice(1)}`;
  return (
    <svg className="md-row-trend" width={width} height={height} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={fill} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={tint} stopOpacity="0.25"/>
          <stop offset="1" stopColor={tint} stopOpacity="0"/>
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${fill})`}/>
      <path d={line} fill="none" stroke={tint} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
      <circle cx={lastX} cy={lastY} r="2" fill={tint}/>
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
        <RowTrend points={row.trend} tint={row.tint}/>
        <span className="md-row-reading">
          {row.latest ? (
            <>
              <span className="md-row-value" aria-hidden="true">
                <span className={`md-row-latest md-status-${row.status ?? 'none'}`}>{row.latest}</span>
                {row.previous && <span className="md-row-prev"> ({row.previous})</span>}
              </span>
              <span className="hr-sr-only">{row.previous ? `${row.latest}, previous ${row.previous}` : row.latest}</span>
              <span className="md-row-unit">{row.unit}</span>
            </>
          ) : <span className="md-row-add">Add</span>}
        </span>
      </button>
    </li>
  );
}

function RowSection({ title, rows, onOpen, children }: { title: string; rows: RowModel[]; onOpen: (s: ValueSubject) => void; children?: React.ReactNode }) {
  return (
    <section className="md-section" aria-label={title}>
      <h3 className="health-section-title md-section-title">{title}</h3>
      <ul className="md-rows">
        {rows.map(row => <MetricRow key={row.subject.kind === 'lab' ? row.subject.seriesKey : row.subject.kind === 'bp' ? 'bp' : row.subject.metric} row={row} onOpen={onOpen}/>)}
      </ul>
      {children}
    </section>
  );
}

export function VitalsRows({ history, ctx, onOpen }: { history: ApiMeasurement[]; ctx: RowContext; onOpen: (s: ValueSubject) => void }) {
  const rows = [coreRow('weight', history, ctx), coreRow('waist', history, ctx), pressureRow(history, ctx)];
  return <RowSection title="Vitals" rows={rows} onOpen={onOpen}/>;
}

export function BloodTestRows({ history, labValues, ctx, onOpen, children }: {
  history: ApiMeasurement[]; labValues: ApiLabValue[]; ctx: RowContext; onOpen: (s: ValueSubject) => void; children?: React.ReactNode;
}) {
  const labs = useMemo(() => labRows(labValues), [labValues]);
  const rows = [...BLOOD_ROWS.map(m => coreRow(m, history, ctx)), ...labs];
  return <RowSection title="Blood tests" rows={rows} onOpen={onOpen}>{children}</RowSection>;
}
