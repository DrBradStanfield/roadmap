import { useState, useMemo } from 'react';
import type { UnitSystem, MetricType } from '@roadmap/health-core';
import { fromCanonicalValue, UNIT_DEFS, METRIC_LABELS } from '@roadmap/health-core';
import { InlineDatePicker, getCurrentDateValue } from './DatePicker';
import type { ExtractedValue, ApiMeasurement, DocumentResult } from '../lib/api';

/** Minimum age for each screening type — matches thresholds in suggestions.ts */
const SCREENING_MIN_AGE: Record<string, { age: number; sex?: 'male' | 'female' }> = {
  colorectal: { age: 35 },
  breast: { age: 40, sex: 'female' },
  cervical: { age: 25, sex: 'female' },
  lung: { age: 50 },
  prostate: { age: 45, sex: 'male' },
  dexa: { age: 50 }, // 50 for female, 70 for male — use 50 as minimum (sex check handles the rest)
};

export interface FileResult {
  fileName: string;
  reportDate: string | null;
  values: ExtractedValue[];
  unrecognized: string[];
  error?: string;
  /** Present for non-lab documents (scan results, clinic letters, etc.) */
  document?: DocumentResult;
}

/** Document to be saved, assembled from review state */
export interface DocumentToSave {
  documentType: string;
  title: string;
  documentDate: string | null;
  contentMd: string;
  metadata: Record<string, unknown>;
  sourceFileName: string | null;
  /** If this maps to a screening type, the key to update (e.g. "colorectal_last_date") */
  screeningUpdate?: { key: string; date: string };
}

/** Exported for testing */
export function isScreeningEligible(screeningType: string, userAge?: number, userSex?: 'male' | 'female'): boolean {
  const rule = SCREENING_MIN_AGE[screeningType];
  if (!rule) return true;
  if (rule.sex && userSex && rule.sex !== userSex) return false;
  if (userAge && userAge < rule.age) return false;
  return true;
}

interface ReviewTableProps {
  results: FileResult[];
  previousMeasurements: ApiMeasurement[];
  unitSystem: UnitSystem;
  birthYear?: number;
  sex?: 'male' | 'female';
  onSave: (
    values: Array<{ metric: string; valueSI: number; recordedAt: string }>,
    documents: DocumentToSave[],
  ) => void;
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
  birthYear,
  sex,
  onSave,
  onCancel,
  isSaving,
  error,
}: ReviewTableProps) {
  const userAge = birthYear ? new Date().getFullYear() - birthYear : undefined;
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

  // Per-document: whether to save this document (default: checked for documents with content)
  const [docChecked, setDocChecked] = useState<Record<number, boolean>>(() => {
    const map: Record<number, boolean> = {};
    results.forEach((r, fi) => { if (r.document) map[fi] = true; });
    return map;
  });

  // Per-document: editable title
  const [docTitles, setDocTitles] = useState<Record<number, string>>(() => {
    const map: Record<number, string> = {};
    results.forEach((r, fi) => { if (r.document) map[fi] = r.document.title; });
    return map;
  });

  // Per-document: whether to update screening date (when screeningType is present AND user is old enough)
  const [screeningChecked, setScreeningChecked] = useState<Record<number, boolean>>(() => {
    const map: Record<number, boolean> = {};
    results.forEach((r, fi) => {
      const st = r.document?.metadata?.screeningType as string | undefined;
      if (st && isScreeningEligible(st, userAge, sex)) {
        map[fi] = true;
      }
    });
    return map;
  });

  const totalValues = useMemo(() => results.reduce((sum, r) => sum + r.values.length, 0), [results]);
  const selectedCount = useMemo(() => Object.values(checked).filter(Boolean).length, [checked]);
  const selectedDocCount = useMemo(() => Object.values(docChecked).filter(Boolean).length, [docChecked]);
  // Only require dates for files that have selected values
  const allDatesSet = useMemo(() => results.every((r, fi) => {
    if (r.error) return true;
    // Lab values: need date if any checked
    if (r.values.length > 0) {
      const hasSelected = r.values.some((_, vi) => checked[`${fi}-${vi}`]);
      if (hasSelected) return !!(fileDates[fi]?.year && fileDates[fi]?.month);
    }
    // Documents: need date if checked (documentDate from LLM is usually present)
    if (r.document && docChecked[fi]) {
      return !!(fileDates[fi]?.year && fileDates[fi]?.month);
    }
    return true;
  }), [results, checked, fileDates, docChecked]);

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
    // Collect lab values
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

    // Collect documents
    const documents: DocumentToSave[] = [];
    results.forEach((r, fi) => {
      if (!r.document || !docChecked[fi]) return;
      const date = fileDates[fi];
      const dateStr = date.year && date.month
        ? `${date.year}-${date.month.padStart(2, '0')}${date.day ? '-' + date.day.padStart(2, '0') : '-01'}`
        : null;

      const screeningType = r.document.metadata?.screeningType as string | undefined;
      const screeningKey = screeningType ? `${screeningType}_last_date` : undefined;

      documents.push({
        documentType: r.document.classification,
        title: docTitles[fi] || r.document.title,
        documentDate: dateStr,
        contentMd: r.document.contentMarkdown,
        metadata: r.document.metadata,
        sourceFileName: r.fileName,
        screeningUpdate: screeningKey && screeningChecked[fi] && dateStr
          ? { key: screeningKey, date: `${date.year}-${date.month.padStart(2, '0')}` }
          : undefined,
      });
    });

    onSave(selected, documents);
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
        {selectedCount > 0 && `${selectedCount} of ${totalValues} value${totalValues !== 1 ? 's' : ''}`}
        {selectedCount > 0 && selectedDocCount > 0 && ' + '}
        {selectedDocCount > 0 && `${selectedDocCount} document${selectedDocCount !== 1 ? 's' : ''}`}
        {selectedCount === 0 && selectedDocCount === 0 && 'No items selected'}
        {' '}from {results.length} file{results.length !== 1 ? 's' : ''}
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
            ) : r.document ? (
              <div className="review-document-card">
                <div className="review-document-header">
                  <label className="review-row-check">
                    <input
                      type="checkbox"
                      checked={docChecked[fi] ?? false}
                      onChange={(e) => setDocChecked(prev => ({ ...prev, [fi]: e.target.checked }))}
                    />
                  </label>
                  <span className={`review-doc-type-badge review-doc-type--${r.document.classification}`}>
                    {r.document.classification.replace(/_/g, ' ')}
                  </span>
                </div>

                <div className="review-document-title">
                  <input
                    type="text"
                    value={docTitles[fi] || ''}
                    onChange={(e) => setDocTitles(prev => ({ ...prev, [fi]: e.target.value }))}
                    className="review-title-input"
                    placeholder="Document title"
                  />
                </div>

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
                </div>

                <div className="review-document-preview">
                  {r.document.contentMarkdown.slice(0, 300)}
                  {r.document.contentMarkdown.length > 300 && '...'}
                </div>

                {r.document.metadata?.screeningType && isScreeningEligible(String(r.document.metadata.screeningType), userAge, sex) && (
                  <label className="review-screening-update">
                    <input
                      type="checkbox"
                      checked={screeningChecked[fi] ?? false}
                      onChange={(e) => setScreeningChecked(prev => ({ ...prev, [fi]: e.target.checked }))}
                    />
                    <span>
                      Update <strong>{String(r.document.metadata.screeningType)}</strong> screening date
                      {r.document.documentDate ? ` to ${r.document.documentDate}` : ''}
                    </span>
                  </label>
                )}
              </div>
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
          disabled={(selectedCount === 0 && selectedDocCount === 0) || !allDatesSet || isSaving}
        >
          {isSaving ? 'Saving...' : `Save ${[
            selectedCount > 0 && `${selectedCount} Value${selectedCount !== 1 ? 's' : ''}`,
            selectedDocCount > 0 && `${selectedDocCount} Document${selectedDocCount !== 1 ? 's' : ''}`,
          ].filter(Boolean).join(' + ')}`}
        </button>
        <button className="review-cancel-btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
