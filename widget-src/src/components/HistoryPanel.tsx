import { useState, useEffect, useRef, useMemo } from 'react';
import {
  type UnitSystem,
  type ApiMeasurement,
  METRIC_TO_FIELD,
  FIELD_METRIC_MAP,
  fromCanonicalValue,
  getDisplayLabel,
  UNIT_DEFS,
  detectUnitSystem,
  METRIC_LABELS,
} from '@roadmap/health-core';
import {
  Chart,
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  TimeScale,
  Tooltip,
  Filler,
} from 'chart.js';
import annotationPlugin from 'chartjs-plugin-annotation';
import 'chartjs-adapter-date-fns';
import { loadAllHistory, loadLabValues, loadMedicationHistory } from '../lib/roadmap-data';
import { trackProductEvent } from '../lib/server-api';
import type { ApiLabValue, ApiMedicationHistory } from '../lib/api-types';
import { loadUnitPreference } from '../lib/storage';
import { groupLabHistory } from '../lib/lab-rows';
import { medicationAnnotations, MED_ANNOTATION_COLOR, type ChartAnnotation } from '../lib/medication-annotations';
import { chartTimestamp, formatShortDate } from '../lib/constants';

// Register only what we need
Chart.register(LineController, LineElement, PointElement, LinearScale, TimeScale, Tooltip, Filler, annotationPlugin);

// Chart colors per metric
const METRIC_COLORS: Record<string, string> = {
  weight: '#0ea5e9',
  waist: '#f59e0b',
  hba1c: '#ef4444',
  ldl: '#f97316',
  hdl: '#22c55e',
  triglycerides: '#a855f7',
  total_cholesterol: '#ec4899',
  apob: '#84cc16',
  systolic_bp: '#14b8a6',
  diastolic_bp: '#64748b',
  creatinine: '#6366f1',
  psa: '#d946ef',
  lpa: '#e11d48',
};

/**
 * Pins closer than ~4% of the axis span would overdraw each other's label, so
 * they share one line whose label lists every entry number (1-based, list order).
 */
function pinClusters(annotations: ChartAnnotation[], span: number): Array<{ date: number; numbers: number[] }> {
  const clusters: Array<{ date: number; numbers: number[] }> = [];
  for (const pin of annotations.map((a, i) => ({ date: a.date, n: i + 1 })).sort((p, q) => p.date - q.date)) {
    const last = clusters.at(-1);
    if (last && pin.date - last.date <= span * 0.04) last.numbers.push(pin.n);
    else clusters.push({ date: pin.date, numbers: [pin.n] });
  }
  return clusters;
}

function toDisplayValue(metricType: string, value: number, unitSystem: UnitSystem): number {
  const field = METRIC_TO_FIELD[metricType];
  if (!field) return value;
  const metric = FIELD_METRIC_MAP[field];
  if (!metric) return value;
  const display = fromCanonicalValue(metric, value, unitSystem);
  const dp = UNIT_DEFS[metric].decimalPlaces[unitSystem];
  return parseFloat(display.toFixed(dp));
}

function getUnitLabel(metricType: string, unitSystem: UnitSystem): string {
  const field = METRIC_TO_FIELD[metricType];
  if (!field) return '';
  const metric = FIELD_METRIC_MAP[field];
  if (!metric) return '';
  return getDisplayLabel(metric, unitSystem);
}

// Auto-assigned colors for lab value metrics (cycle through a palette)
const LAB_VALUE_PALETTE = [
  '#0ea5e9', '#f97316', '#22c55e', '#a855f7', '#ef4444',
  '#14b8a6', '#ec4899', '#84cc16', '#6366f1', '#f59e0b',
  '#d946ef', '#64748b', '#e11d48', '#059669', '#7c3aed',
];

// Generic time-series line chart — used for both core metrics and additional lab values
function TimeSeriesChart({
  title,
  data,
  unit,
  color,
  annotations,
}: {
  title: string;
  data: Array<{ x: number; y: number }>;
  unit: string;
  color: string;
  annotations?: ChartAnnotation[];
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);

  useEffect(() => {
    if (!canvasRef.current || data.length === 0) return;

    const sorted = [...data].sort((a, b) => a.x - b.x);

    const DAY = 86400000;
    const dates = [...sorted.map(point => point.x), ...(annotations ?? []).map(a => a.date)];
    const xMin = Math.min(...dates) - (sorted.length === 1 ? 7 * DAY : 0);
    const xMax = Math.max(...dates) + (sorted.length === 1 ? 7 * DAY : 0);

    if (chartRef.current) {
      chartRef.current.destroy();
    }

    chartRef.current = new Chart(canvasRef.current, {
      type: 'line',
      data: {
        datasets: [{
          data: sorted,
          borderColor: color,
          backgroundColor: color + '1a',
          pointBackgroundColor: color,
          pointRadius: 4,
          pointHoverRadius: 7,
          borderWidth: 2,
          tension: 0.3,
          fill: true,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          tooltip: {
            callbacks: {
              title: (items) => {
                const x = items[0]?.parsed.x;
                if (x == null) return '';
                return formatShortDate(x);
              },
              label: (item) => `${+Number(item.parsed.y).toPrecision(10)} ${unit}`,
            },
          },
          annotation: annotations && annotations.length > 0 ? {
            annotations: Object.fromEntries(pinClusters(annotations, xMax - xMin).map(({ date, numbers }) => [`med_${numbers[0]}`, {
              type: 'line' as const,
              xMin: date,
              xMax: date,
              borderColor: MED_ANNOTATION_COLOR,
              borderDash: [4, 4],
              borderWidth: 1,
              label: {
                content: numbers.join(', '), display: true, position: 'start' as const,
                backgroundColor: MED_ANNOTATION_COLOR, font: { size: 10 }, padding: { x: 4, y: 2 },
              },
            }])),
          } : undefined,
        },
        scales: {
          x: {
            type: 'time',
            min: xMin,
            max: xMax,
            time: {
              minUnit: 'day',
              tooltipFormat: 'MMM d, yyyy',
              displayFormats: { day: 'MMM d', week: 'MMM d', month: 'MMM yyyy', year: 'yyyy' },
            },
            grid: { display: false },
            ticks: { font: { size: 11 }, maxTicksLimit: 8 },
          },
          y: {
            beginAtZero: false,
            grid: { color: '#f0f0f0' },
            ticks: {
              font: { size: 11 },
              callback: (value) => `${+Number(value).toPrecision(10)}`,
            },
            title: { display: true, text: unit, font: { size: 12 } },
          },
        },
      },
    });

    return () => {
      if (chartRef.current) {
        chartRef.current.destroy();
        chartRef.current = null;
      }
    };
  }, [data, title, unit, color, annotations]);

  return (
    <div className="metric-chart-container">
      <h3>{title}</h3>
      <div className="metric-chart-canvas-wrap">
        <canvas ref={canvasRef} />
      </div>
      {annotations && annotations.length > 0 && (
        <ol className="metric-chart-events" aria-label={`${title} recorded medication changes`}>
          {annotations.map((annotation, index) => (
            <li key={index}>{formatShortDate(annotation.date)}: {annotation.label}</li>
          ))}
        </ol>
      )}
    </div>
  );
}

interface HistoryPanelProps {
  /** Pre-select one metric (lightbox embedding). Falls back to ?metric= (the Shopify page). */
  initialMetric?: string;
}

export function HistoryPanel({ initialMetric }: HistoryPanelProps) {
  const [measurements, setMeasurements] = useState<ApiMeasurement[]>([]);
  const [labVals, setLabVals] = useState<ApiLabValue[]>([]);
  const [loading, setLoading] = useState(true);
  const [unitSystem] = useState<UnitSystem>(() => loadUnitPreference() ?? detectUnitSystem());

  // Selected metrics (initialized after first fetch)
  const [selectedMetrics, setSelectedMetrics] = useState<Set<string>>(new Set());
  const [selectedLabMetrics, setSelectedLabMetrics] = useState<Set<string>>(new Set());
  const [initialized, setInitialized] = useState(false);
  const [medHistory, setMedHistory] = useState<ApiMedicationHistory[]>([]);
  const [showMedAnnotations, setShowMedAnnotations] = useState(true);

  useEffect(() => {
    // The local store returns the complete history. There is no server page
    // to append, even when the record happens to contain exactly 50 rows.
    loadAllHistory().then(rows => {
      setMeasurements(rows);
      setLoading(false);
    });
    loadLabValues().then(rows => { if (rows) setLabVals(rows); });
    loadMedicationHistory().then(setMedHistory);
  }, []);

  // Initialize selected metrics from URL param or default to all
  useEffect(() => {
    if (initialized || (measurements.length === 0 && labVals.length === 0)) return;
    const params = new URLSearchParams(window.location.search);
    const metricParam = initialMetric ?? params.get('metric');
    const allTypes = [...new Set(measurements.map((m) => m.metricType))];

    if (metricParam && allTypes.includes(metricParam)) {
      setSelectedMetrics(new Set([metricParam]));
    } else {
      setSelectedMetrics(new Set(allTypes));
    }

    // Initialize lab value metrics — all selected by default
    setSelectedLabMetrics(new Set(groupLabHistory(labVals).keys));

    setInitialized(true);
  }, [measurements, labVals, initialized, initialMetric]);

  const toggleMetric = (metric: string) => {
    setSelectedMetrics((prev) => {
      const next = new Set(prev);
      if (next.has(metric)) { next.delete(metric); } else { next.add(metric); }
      return next;
    });
  };

  const toggleLabMetric = (metric: string) => {
    setSelectedLabMetrics((prev) => {
      const next = new Set(prev);
      if (next.has(metric)) { next.delete(metric); } else { next.add(metric); }
      return next;
    });
  };

  const annotationsByMetric = useMemo(
    () => showMedAnnotations ? medicationAnnotations(medHistory) : {},
    [medHistory, showMedAnnotations],
  );

  useEffect(() => {
    if (Object.keys(annotationsByMetric).some(metric => selectedMetrics.has(metric) && measurements.some(row => row.metricType === metric))) {
      trackProductEvent('medication_history_viewed');
    }
  }, [annotationsByMetric, selectedMetrics, measurements]);

  // Group measurements by metricType (memoized)
  const { grouped, metricTypes } = useMemo(() => {
    const g: Record<string, ApiMeasurement[]> = {};
    for (const m of measurements) {
      if (!g[m.metricType]) g[m.metricType] = [];
      g[m.metricType].push(m);
    }
    return { grouped: g, metricTypes: Object.keys(g).sort() };
  }, [measurements]);

  // One series per lab slot key, so spelling variants share a chart (US-10).
  const { labSeries, labMetricNames, labColorMap } = useMemo(() => {
    const { keys, series } = groupLabHistory(labVals);
    const colors: Record<string, string> = {};
    keys.forEach((key, i) => {
      colors[key] = LAB_VALUE_PALETTE[i % LAB_VALUE_PALETTE.length];
    });
    return { labSeries: series, labMetricNames: keys, labColorMap: colors };
  }, [labVals]);

  return (
    <div className="history-panel">
      <h2>Health History</h2>

      {loading && measurements.length === 0 ? (
        <p className="history-loading">Loading history...</p>
      ) : metricTypes.length === 0 && labMetricNames.length === 0 ? (
        <p className="history-empty">No measurements recorded yet.</p>
      ) : (
        <>
          <div className="metric-selector">
            {metricTypes.map((mt) => (
              <label key={mt} className="metric-checkbox">
                <input
                  type="checkbox"
                  checked={selectedMetrics.has(mt)}
                  onChange={() => toggleMetric(mt)}
                />
                <span
                  className="metric-color-dot"
                  style={{ background: METRIC_COLORS[mt] || '#0066cc' }}
                />
                {METRIC_LABELS[mt] || mt}
              </label>
            ))}
          </div>

          {medHistory.length > 0 && (
            <label className="metric-checkbox" style={{ marginBottom: 8 }}>
              <input
                type="checkbox"
                checked={showMedAnnotations}
                onChange={() => setShowMedAnnotations(p => !p)}
              />
              <span className="metric-color-dot" style={{ background: MED_ANNOTATION_COLOR }} />
              Show recorded medication changes
            </label>
          )}

          {medHistory.length > 0 && showMedAnnotations && (
            <p className="history-note">Markers show when you recorded a change, which may differ from when treatment changed.</p>
          )}

          {metricTypes
            .filter((mt) => selectedMetrics.has(mt))
            .map((mt) => (
              <TimeSeriesChart
                key={mt}
                title={METRIC_LABELS[mt] || mt}
                data={grouped[mt].map((m) => ({
                  x: chartTimestamp(m.recordedAt),
                  y: toDisplayValue(mt, m.value, unitSystem),
                }))}
                unit={getUnitLabel(mt, unitSystem)}
                color={METRIC_COLORS[mt] || '#0066cc'}
                annotations={annotationsByMetric[mt]}
              />
            ))}

          {labMetricNames.length > 0 && (
            <>
              <h2 className="history-section-title">Additional Lab Results</h2>

              <div className="metric-selector">
                {labMetricNames.map((name) => (
                  <label key={name} className="metric-checkbox">
                    <input
                      type="checkbox"
                      checked={selectedLabMetrics.has(name)}
                      onChange={() => toggleLabMetric(name)}
                    />
                    <span
                      className="metric-color-dot"
                      style={{ background: labColorMap[name] }}
                    />
                    {labSeries[name].label}
                  </label>
                ))}
              </div>

              {labMetricNames
                .filter((name) => selectedLabMetrics.has(name))
                .map((name) => {
                  // Use the unit from the first value (consistent per metric)
                  const unit = labSeries[name].rows[0]?.unit || '';
                  return (
                    <TimeSeriesChart
                      key={name}
                      title={labSeries[name].label}
                      data={labSeries[name].rows.map((v) => ({
                        x: chartTimestamp(v.recordedAt),
                        y: v.value,
                      }))}
                      unit={unit}
                      color={labColorMap[name]}
                    />
                  );
                })}
            </>
          )}
        </>
      )}
    </div>
  );
}
