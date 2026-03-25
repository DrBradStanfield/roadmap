import { useState, useMemo } from 'react';
import type { UnitSystem, MetricType } from '@roadmap/health-core';
import { fromCanonicalValue, UNIT_DEFS, METRIC_LABELS } from '@roadmap/health-core';
import { DatePicker, dateValueToISO, getCurrentDateValue, type DateValue } from './DatePicker';
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

function parseReportDate(dateStr: string | null): DateValue {
  if (!dateStr) return getCurrentDateValue();
  const [year, month] = dateStr.split('-');
  return { year: year || getCurrentDateValue().year, month: month || getCurrentDateValue().month };
}

/**
 * Build the ISO date string for saving. If the LLM extracted a full date (YYYY-MM-DD)
 * and the user hasn't changed the month/year, use the original date with day precision.
 * Otherwise fall back to first-of-month from the DatePicker.
 */
function buildRecordedAt(
  originalDate: string | null,
  pickerDate: DateValue,
): string {
  if (originalDate) {
    const [origYear, origMonth] = originalDate.split('-');
    // User hasn't changed the date — use the full original (preserves day)
    if (origYear === pickerDate.year && origMonth === pickerDate.month.padStart(2, '0')) {
      return `${originalDate}T00:00:00.000Z`;
    }
  }
  // User changed the date or no original — use first-of-month
  return dateValueToISO(pickerDate);
}

/**
 * Check if a measurement with this metric + date already exists.
 * Uses full YYYY-MM-DD prefix if available, otherwise YYYY-MM.
 */
function isDuplicate(
  metric: string,
  originalDate: string | null,
  pickerDate: DateValue,
  previousMeasurements: ApiMeasurement[],
): boolean {
  // Build the prefix to match against — use most precise date available
  let isoPrefix: string;
  if (originalDate) {
    const [origYear, origMonth] = originalDate.split('-');
    if (origYear === pickerDate.year && origMonth === pickerDate.month.padStart(2, '0')) {
      // Full date available and user hasn't changed it — match exact day
      isoPrefix = originalDate; // e.g. "2024-11-21"
    } else {
      // User changed date — match month
      isoPrefix = `${pickerDate.year}-${pickerDate.month.padStart(2, '0')}`;
    }
  } else {
    // No original date — match month
    isoPrefix = `${pickerDate.year}-${pickerDate.month.padStart(2, '0')}`;
  }

  return previousMeasurements.some(
    m => m.metricType === metric && m.recordedAt.startsWith(isoPrefix),
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
  // Per-file date state (for DatePicker display)
  const [fileDates, setFileDates] = useState<Record<number, DateValue>>(() => {
    const dates: Record<number, DateValue> = {};
    results.forEach((r, i) => { dates[i] = parseReportDate(r.reportDate); });
    return dates;
  });

  // Track whether the user has manually changed the date (overrides LLM date)
  const [dateOverridden, setDateOverridden] = useState<Record<number, boolean>>({});

  // Per-value checked state
  const [checked, setChecked] = useState<Record<string, boolean>>(() => {
    const map: Record<string, boolean> = {};
    results.forEach((r, fi) => {
      r.values.forEach((v, vi) => {
        const key = `${fi}-${vi}`;
        const dup = isDuplicate(v.metric, r.reportDate, parseReportDate(r.reportDate), previousMeasurements);
        map[key] = !dup && v.confidence !== 'low';
      });
    });
    return map;
  });

  const totalValues = useMemo(() => results.reduce((sum, r) => sum + r.values.length, 0), [results]);
  const selectedCount = useMemo(() => Object.values(checked).filter(Boolean).length, [checked]);
  const allDatesSet = results.every((r, i) => !r.error && (fileDates[i]?.year && fileDates[i]?.month));

  const handleDateChange = (fi: number, val: DateValue) => {
    setFileDates(prev => ({ ...prev, [fi]: val }));
    setDateOverridden(prev => ({ ...prev, [fi]: true }));
  };

  const handleSave = () => {
    const selected: Array<{ metric: string; valueSI: number; recordedAt: string }> = [];
    results.forEach((r, fi) => {
      r.values.forEach((v, vi) => {
        const key = `${fi}-${vi}`;
        if (!checked[key]) return;
        const date = fileDates[fi];
        const originalDate = dateOverridden[fi] ? null : r.reportDate;
        selected.push({
          metric: v.metric,
          valueSI: v.valueSI,
          recordedAt: buildRecordedAt(originalDate, date),
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

      {results.map((r, fi) => (
        <div key={fi} className="review-file-section">
          <div className="review-file-header">
            <span className="review-file-name">{r.fileName}</span>
          </div>

          {r.error ? (
            <p className="review-file-error">Could not read this file: {r.error}</p>
          ) : (
            <>
              <div className="review-file-date">
                <span>Date: </span>
                <DatePicker
                  value={fileDates[fi]}
                  onChange={(val) => handleDateChange(fi, val)}
                  shortMonths
                  yearCount={11}
                />
                {!r.reportDate && (
                  <span className="review-date-warning">Date not found — please select</span>
                )}
              </div>

              {r.values.length === 0 ? (
                <p className="review-no-values">No blood test values found in this file</p>
              ) : (
                <div className="review-rows">
                  {r.values.map((v, vi) => {
                    const key = `${fi}-${vi}`;
                    const originalDate = dateOverridden[fi] ? null : r.reportDate;
                    const dup = isDuplicate(v.metric, originalDate, fileDates[fi], previousMeasurements);
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
              )}

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
      ))}

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
