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

function isDuplicate(
  metric: string,
  date: DateValue,
  previousMeasurements: ApiMeasurement[],
): boolean {
  const isoPrefix = `${date.year}-${date.month}`;
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
  // Per-file date state
  const [fileDates, setFileDates] = useState<Record<number, DateValue>>(() => {
    const dates: Record<number, DateValue> = {};
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
  const allDatesSet = results.every((r, i) => !r.error && (fileDates[i]?.year && fileDates[i]?.month));

  const handleSave = () => {
    const selected: Array<{ metric: string; valueSI: number; recordedAt: string }> = [];
    results.forEach((r, fi) => {
      r.values.forEach((v, vi) => {
        const key = `${fi}-${vi}`;
        if (!checked[key]) return;
        const date = fileDates[fi];
        selected.push({
          metric: v.metric,
          valueSI: v.valueSI,
          recordedAt: dateValueToISO(date),
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
                  onChange={(val) => setFileDates(prev => ({ ...prev, [fi]: val }))}
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
