import { useState, useEffect, useCallback } from 'react';
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
import { loadAllHistory } from '../lib/api';
import { loadUnitPreference } from '../lib/storage';

// Human-readable metric names
const METRIC_LABELS: Record<string, string> = {
  height: 'Height',
  weight: 'Weight',
  waist: 'Waist',
  hba1c: 'HbA1c',
  ldl: 'LDL Cholesterol',
  hdl: 'HDL Cholesterol',
  triglycerides: 'Triglycerides',
  fasting_glucose: 'Fasting Glucose',
  systolic_bp: 'Systolic BP',
  diastolic_bp: 'Diastolic BP',
};

interface HistoryPanelProps {
  isLoggedIn: boolean;
  loginUrl?: string;
}

export function HistoryPanel({ isLoggedIn, loginUrl }: HistoryPanelProps) {
  const [measurements, setMeasurements] = useState<ApiMeasurement[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('metric') || 'all';
  });
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [unitSystem] = useState<UnitSystem>(() => loadUnitPreference() ?? detectUnitSystem());

  const PAGE_SIZE = 50;

  const fetchHistory = useCallback(async (currentOffset: number, append: boolean) => {
    setLoading(true);
    const data = await loadAllHistory(PAGE_SIZE, currentOffset);
    if (append) {
      setMeasurements(prev => [...prev, ...data]);
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

  const handleLoadMore = () => {
    const newOffset = offset + PAGE_SIZE;
    setOffset(newOffset);
    fetchHistory(newOffset, true);
  };

  const formatValue = (m: ApiMeasurement): string => {
    const field = METRIC_TO_FIELD[m.metricType];
    if (!field) return String(m.value);
    const metric = FIELD_METRIC_MAP[field];
    if (!metric) return String(m.value);
    const display = fromCanonicalValue(metric, m.value, unitSystem);
    const dp = UNIT_DEFS[metric].decimalPlaces[unitSystem];
    return `${parseFloat(display.toFixed(dp))} ${getDisplayLabel(metric, unitSystem)}`;
  };

  const formatDate = (dateStr: string): string => {
    return new Date(dateStr).toLocaleDateString(undefined, {
      month: 'short', day: 'numeric', year: 'numeric',
    });
  };

  if (!isLoggedIn) {
    return (
      <div className="history-panel">
        <div className="history-guest">
          <p>
            <a href={loginUrl || '/account/login'} className="login-link">Log in</a> to view your health history.
          </p>
        </div>
      </div>
    );
  }

  const filtered = filter === 'all'
    ? measurements
    : measurements.filter(m => m.metricType === filter);

  // Get unique metric types for filter dropdown
  const metricTypes = [...new Set(measurements.map(m => m.metricType))].sort();

  return (
    <div className="history-panel">
      <h2>Health History</h2>

      <div className="history-filter">
        <label htmlFor="metric-filter">Filter by metric:</label>
        <select
          id="metric-filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          <option value="all">All metrics</option>
          {metricTypes.map(mt => (
            <option key={mt} value={mt}>{METRIC_LABELS[mt] || mt}</option>
          ))}
        </select>
      </div>

      {loading && measurements.length === 0 ? (
        <p className="history-loading">Loading history...</p>
      ) : filtered.length === 0 ? (
        <p className="history-empty">No measurements recorded yet.</p>
      ) : (
        <>
          <table className="history-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Metric</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(m => (
                <tr key={m.id}>
                  <td>{formatDate(m.recordedAt)}</td>
                  <td>{METRIC_LABELS[m.metricType] || m.metricType}</td>
                  <td>{formatValue(m)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {hasMore && filter === 'all' && (
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
