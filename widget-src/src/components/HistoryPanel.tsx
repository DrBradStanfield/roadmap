import { useState, useEffect, useCallback, useRef } from 'react';
import {
  type UnitSystem,
  type ApiMeasurement,
  METRIC_TO_FIELD,
  FIELD_METRIC_MAP,
  fromCanonicalValue,
  getDisplayLabel,
  UNIT_DEFS,
  detectUnitSystem,
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
import 'chartjs-adapter-date-fns';
import { loadAllHistory } from '../lib/api';
import { loadUnitPreference } from '../lib/storage';

// Register only what we need
Chart.register(LineController, LineElement, PointElement, LinearScale, TimeScale, Tooltip, Filler);

// Human-readable metric names (no height — stored on profile, not as time-series)
const METRIC_LABELS: Record<string, string> = {
  weight: 'Weight',
  waist: 'Waist',
  hba1c: 'HbA1c',
  ldl: 'LDL Cholesterol',
  hdl: 'HDL Cholesterol',
  triglycerides: 'Triglycerides',
  total_cholesterol: 'Total Cholesterol',
  apob: 'ApoB',
  systolic_bp: 'Systolic BP',
  diastolic_bp: 'Diastolic BP',
  creatinine: 'Creatinine',
  psa: 'PSA',
  lpa: 'Lp(a)',
};

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

// Individual chart component for one metric
function MetricChart({
  metricType,
  measurements,
  unitSystem,
}: {
  metricType: string;
  measurements: ApiMeasurement[];
  unitSystem: UnitSystem;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);

  useEffect(() => {
    if (!canvasRef.current) return;

    // Sort chronologically
    const sorted = [...measurements].sort(
      (a, b) => new Date(a.recordedAt).getTime() - new Date(b.recordedAt).getTime(),
    );

    const color = METRIC_COLORS[metricType] || '#0066cc';
    const unit = getUnitLabel(metricType, unitSystem);

    // For single data points, add ±7 day padding so the x-axis date is visible
    const timestamps = sorted.map((m) => new Date(m.recordedAt).getTime());
    const DAY = 86400000;
    const xMin = sorted.length === 1 ? timestamps[0] - 7 * DAY : undefined;
    const xMax = sorted.length === 1 ? timestamps[0] + 7 * DAY : undefined;

    // Destroy previous chart
    if (chartRef.current) {
      chartRef.current.destroy();
    }

    chartRef.current = new Chart(canvasRef.current, {
      type: 'line',
      data: {
        datasets: [
          {
            data: sorted.map((m) => ({
              x: new Date(m.recordedAt).getTime(),
              y: toDisplayValue(metricType, m.value, unitSystem),
            })),
            borderColor: color,
            backgroundColor: color + '1a',
            pointBackgroundColor: color,
            pointRadius: 4,
            pointHoverRadius: 7,
            borderWidth: 2,
            tension: 0.3,
            fill: true,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          tooltip: {
            callbacks: {
              title: (items) => {
                if (!items.length) return '';
                const date = new Date(items[0].parsed.x);
                return date.toLocaleDateString(undefined, {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                });
              },
              label: (item) => `${+Number(item.parsed.y).toPrecision(10)} ${unit}`,
            },
          },
        },
        scales: {
          x: {
            type: 'time',
            min: xMin,
            max: xMax,
            time: {
              minUnit: 'day',
              tooltipFormat: 'MMM d, yyyy',
              displayFormats: {
                day: 'MMM d',
                week: 'MMM d',
                month: 'MMM yyyy',
                year: 'yyyy',
              },
            },
            grid: { display: false },
            ticks: {
              font: { size: 11 },
              maxTicksLimit: 8,
            },
          },
          y: {
            beginAtZero: false,
            grid: { color: '#f0f0f0' },
            ticks: {
              font: { size: 11 },
              callback: (value) => `${+Number(value).toPrecision(10)}`,
            },
            title: {
              display: true,
              text: unit,
              font: { size: 12 },
            },
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
  }, [measurements, metricType, unitSystem]);

  return (
    <div className="metric-chart-container">
      <h3>{METRIC_LABELS[metricType] || metricType}</h3>
      <div className="metric-chart-canvas-wrap">
        <canvas ref={canvasRef} />
      </div>
    </div>
  );
}

interface HistoryPanelProps {
  isLoggedIn: boolean;
  loginUrl?: string;
}

export function HistoryPanel({ isLoggedIn, loginUrl }: HistoryPanelProps) {
  const [measurements, setMeasurements] = useState<ApiMeasurement[]>([]);
  const [loading, setLoading] = useState(true);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [unitSystem] = useState<UnitSystem>(() => loadUnitPreference() ?? detectUnitSystem());

  // Selected metrics (initialized after first fetch)
  const [selectedMetrics, setSelectedMetrics] = useState<Set<string>>(new Set());
  const [initialized, setInitialized] = useState(false);

  const PAGE_SIZE = 50;

  const fetchHistory = useCallback(async (currentOffset: number, append: boolean) => {
    setLoading(true);
    const data = await loadAllHistory(PAGE_SIZE, currentOffset);
    if (append) {
      setMeasurements((prev) => [...prev, ...data]);
    } else {
      setMeasurements(data);
    }
    setHasMore(data.length === PAGE_SIZE);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (isLoggedIn) {
      fetchHistory(0, false);
    } else {
      setLoading(false);
    }
  }, [isLoggedIn, fetchHistory]);

  // Initialize selected metrics from URL param or default to all
  useEffect(() => {
    if (initialized || measurements.length === 0) return;
    const params = new URLSearchParams(window.location.search);
    const metricParam = params.get('metric');
    const allTypes = [...new Set(measurements.map((m) => m.metricType))];

    if (metricParam && allTypes.includes(metricParam)) {
      setSelectedMetrics(new Set([metricParam]));
    } else {
      setSelectedMetrics(new Set(allTypes));
    }
    setInitialized(true);
  }, [measurements, initialized]);

  const handleLoadMore = () => {
    const newOffset = offset + PAGE_SIZE;
    setOffset(newOffset);
    fetchHistory(newOffset, true);
  };

  const toggleMetric = (metric: string) => {
    setSelectedMetrics((prev) => {
      const next = new Set(prev);
      if (next.has(metric)) {
        next.delete(metric);
      } else {
        next.add(metric);
      }
      return next;
    });
  };

  if (!isLoggedIn) {
    return (
      <div className="history-panel">
        <div className="history-guest">
          <p>
            <a href={loginUrl || '/account/login'} style={{ color: 'var(--color-primary)', textDecoration: 'none', fontWeight: 500 }}>
              Log in
            </a>{' '}
            to view your health history.
          </p>
        </div>
      </div>
    );
  }

  // Group measurements by metricType
  const grouped: Record<string, ApiMeasurement[]> = {};
  for (const m of measurements) {
    if (!grouped[m.metricType]) grouped[m.metricType] = [];
    grouped[m.metricType].push(m);
  }
  const metricTypes = Object.keys(grouped).sort();

  return (
    <div className="history-panel">
      <h2>Health History</h2>

      {loading && measurements.length === 0 ? (
        <p className="history-loading">Loading history...</p>
      ) : metricTypes.length === 0 ? (
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

          {metricTypes
            .filter((mt) => selectedMetrics.has(mt))
            .map((mt) => (
              <MetricChart
                key={mt}
                metricType={mt}
                measurements={grouped[mt]}
                unitSystem={unitSystem}
              />
            ))}

          {hasMore && (
            <button
              className="history-load-more"
              onClick={handleLoadMore}
              disabled={loading}
            >
              {loading ? 'Loading...' : 'Load more'}
            </button>
          )}
        </>
      )}
    </div>
  );
}
