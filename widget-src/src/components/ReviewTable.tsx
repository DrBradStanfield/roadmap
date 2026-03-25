import { useState, useMemo } from 'react';
import type { UnitSystem, MetricType } from '@roadmap/health-core';
import { fromCanonicalValue, UNIT_DEFS, METRIC_LABELS } from '@roadmap/health-core';
import { InlineDatePicker, getCurrentDateValue } from './DatePicker';
import type { ExtractedValue, ApiMeasurement } from '../lib/api';

export interface FileResult {
  fileName: string;
  reportDate: string | null;
  values: ExtractedValue[];
  unrecognized: string[];
  error?: string;
}

interface ReviewTableProps {
  results: FileResult[];
  previousMeasurements: ApiMeasurement[];
  unitSystem: UnitSystem;
  onSave: (values: Array<{ metric: string; valueSI: number; recordedAt: string }>) => void;
  onCancel: () => void;
  isSaving: boolean;
  error: string | null;
}

/** Full date state: day/month/year. Day is null when the LLM didn't extract one. */
interface FullDate {
  day: string | null; // "01"-"31" or null
  month: string;      // "1"-"12"
  year: string;       // "2024"
}

function parseReportDate(dateStr: string | null): FullDate {
  if (!dateStr) {
    const now = getCurrentDateValue();
    return { day: null, month: now.month, year: now.year };
  }
  const parts = dateStr.split('-');
  const now = getCurrentDateValue();
  return {
    day: parts.length >= 3 ? parts[2] : null,
    month: parts[1] || now.month,
    year: parts[0] || now.year,
  };
}

function getDaysInMonth(month: string, year: string): number {
  return new Date(parseInt(year), parseInt(month), 0).getDate();
}

/** Build YYYY-MM-DD or YYYY-MM-01 ISO string from FullDate state. */
function buildRecordedAt(date: FullDate): string {
  const month = date.month.padStart(2, '0');
  const day = date.day ? date.day.padStart(2, '0') : '01';
  return `${date.year}-${month}-${day}T00:00:00.000Z`;
}

/** Build the most precise date prefix for duplicate matching. */
function buildDatePrefix(date: FullDate): string {
  const month = date.month.padStart(2, '0');
  if (date.day) {
    return `${date.year}-${month}-${date.day.padStart(2, '0')}`;
  }
  return `${date.year}-${month}`;
}

function isDuplicate(
  metric: string,
  date: FullDate,
  previousMeasurements: ApiMeasurement[],
): boolean {
  const prefix = buildDatePrefix(date);
  return previousMeasurements.some(
    m => m.metricType === metric && m.recordedAt.startsWith(prefix),
  );
}

export function ReviewTable({
  results,
  previousMeasurements,
  unitSystem,
  onSave,
  onCancel,
  isSaving,
  error,
}: ReviewTableProps) {
  // Per-file full date state (day/month/year)
  const [fileDates, setFileDates] = useState<Record<number, FullDate>>(() => {
    const dates: Record<number, FullDate> = {};
    results.forEach((r, i) => { dates[i] = parseReportDate(r.reportDate); });
    return dates;
  });

  // Per-value checked state
  const [checked, setChecked] = useState<Record<string, boolean>>(() => {
    const map: Record<string, boolean> = {};
    results.forEach((r, fi) => {
      r.values.forEach((v, vi) => {
        const key = `${fi}-${vi}`;
        const dup = isDuplicate(v.metric, parseReportDate(r.reportDate), previousMeasurements);
        map[key] = !dup && v.confidence !== 'low';
      });
    });
    return map;
  });

  const totalValues = useMemo(() => results.reduce((sum, r) => sum + r.values.length, 0), [results]);
  const selectedCount = useMemo(() => Object.values(checked).filter(Boolean).length, [checked]);
  // Only require dates for files that have selected values
  const allDatesSet = useMemo(() => results.every((r, fi) => {
    if (r.error || r.values.length === 0) return true;
    const hasSelected = r.values.some((_, vi) => checked[`${fi}-${vi}`]);
    if (!hasSelected) return true;
    return fileDates[fi]?.year && fileDates[fi]?.month;
  }), [results, checked, fileDates]);

  const handleDateChange = (fi: number, update: Partial<FullDate>) => {
    setFileDates(prev => {
      const current = prev[fi];
      const next = { ...current, ...update };
      // Clamp day if it exceeds new month's max
      if (next.day) {
        const maxDay = getDaysInMonth(next.month, next.year);
        if (parseInt(next.day) > maxDay) {
          next.day = String(maxDay);
        }
      }
      return { ...prev, [fi]: next };
    });
  };

  const handleSave = () => {
    const selected: Array<{ metric: string; valueSI: number; recordedAt: string }> = [];
    results.forEach((r, fi) => {
      r.values.forEach((v, vi) => {
        const key = `${fi}-${vi}`;
        if (!checked[key]) return;
        selected.push({
          metric: v.metric,
          valueSI: v.valueSI,
          recordedAt: buildRecordedAt(fileDates[fi]),
        });
      });
    });
    onSave(selected);
  };

  const formatValue = (v: ExtractedValue) => {
    const metric = v.metric as MetricType;
    if (UNIT_DEFS[metric]) {
      const displayVal = fromCanonicalValue(metric, v.valueSI, unitSystem);
      const label = UNIT_DEFS[metric].label[unitSystem];
      const dp = UNIT_DEFS[metric].decimalPlaces[unitSystem];
      return `${displayVal.toFixed(dp)} ${label}`;
    }
    return `${v.displayValue} ${v.displayUnit}`;
  };

  return (
    <div className="review-table">
      <div className="review-summary">
        {selectedCount} of {totalValues} values selected from {results.length} file{results.length !== 1 ? 's' : ''}
      </div>

      {results.map((r, fi) => {
        const date = fileDates[fi];
        const maxDay = getDaysInMonth(date.month, date.year);
        const dayOptions = Array.from({ length: maxDay }, (_, i) => i + 1);

        return (
          <div key={fi} className="review-file-section">
            <div className="review-file-header">
              <span className="review-file-name">{r.fileName}</span>
            </div>

            {r.error ? (
              <p className="review-file-error">Could not read this file: {r.error}</p>
            ) : r.values.length === 0 ? (
              <p className="review-no-values">No blood test values found in this file</p>
            ) : (
              <>
                <div className="review-file-date">
                  <span>Date:</span>
                  <select
                    value={date.day || ''}
                    onChange={(e) => handleDateChange(fi, { day: e.target.value || null })}
                    aria-label="Day"
                    className="review-date-select"
                  >
                    <option value="">--</option>
                    {dayOptions.map(d => (
                      <option key={d} value={String(d).padStart(2, '0')}>
                        {d}
                      </option>
                    ))}
                  </select>
                  <InlineDatePicker
                    value={{ year: date.year, month: date.month }}
                    onChange={(val) => handleDateChange(fi, { month: val.month, year: val.year })}
                    shortMonths
                    yearCount={11}
                  />
                  {!r.reportDate && (
                    <span className="review-date-warning">Date not found — please select</span>
                  )}
                </div>

                <div className="review-rows">
                    {r.values.map((v, vi) => {
                      const key = `${fi}-${vi}`;
                      const dup = isDuplicate(v.metric, fileDates[fi], previousMeasurements);
                      return (
                        <div key={key} className={`review-row review-row--${v.confidence}`}>
                          <label className="review-row-check">
                            <input
                              type="checkbox"
                              checked={checked[key] ?? false}
                              onChange={(e) => setChecked(prev => ({ ...prev, [key]: e.target.checked }))}
                            />
                          </label>
                          <span className="review-row-metric">
                            {METRIC_LABELS[v.metric] || v.metric}
                          </span>
                          <span className="review-row-value">{formatValue(v)}</span>
                          <span className={`review-row-confidence review-confidence--${v.confidence}`}>
                            ●
                          </span>
                          {dup && <span className="review-row-dup">Already saved</span>}
                          {v.question && (
                            <p className="review-row-question">{v.question}</p>
                          )}
                        </div>
                      );
                    })}
                  </div>

                {r.unrecognized.length > 0 && (
                  <div className="review-unrecognized">
                    <p className="review-unrecognized-label">Not tracked:</p>
                    {r.unrecognized.map((u, i) => (
                      <span key={i} className="review-unrecognized-item">{u}</span>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        );
      })}

      {error && <p className="upload-error">{error}</p>}

      <div className="review-actions">
        <button
          className="btn-primary review-save-btn"
          onClick={handleSave}
          disabled={selectedCount === 0 || !allDatesSet || isSaving}
        >
          {isSaving ? 'Saving...' : `Save ${selectedCount} Value${selectedCount !== 1 ? 's' : ''}`}
        </button>
        <button className="review-cancel-btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
