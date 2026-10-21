// The iPhone app's lab upload review (US-52 AC8): what the server proposed,
// shown for the user to tick, and the ticked values turned into health-core's
// bulk rows. The write itself is `bulkAppendValues`, the website's and the
// connector's one bulk rule (my-data.ts `labImport`). No clinical rule here.
import type { RoadmapFile } from '../../packages/health-core/src/roadmap-file';
import { bulkAppendValues, validDay, type BulkRow } from '../../packages/health-core/src/record-edits';
import { METRIC_LABELS } from '../../packages/health-core/src/mappings';
import type { AdditionalLabValue, ExtractedValue, RefusedLabValue } from '../../packages/health-core/src/lab-extraction';

/** The server's answer (`data` of POST /api/app/v1/lab-import). */
export interface Extraction {
  classification: string;
  reportDate: string | null;
  values?: ExtractedValue[];
  additionalValues?: AdditionalLabValue[];
  refusedValues?: RefusedLabValue[];
  droppedValueCount?: number;
}

export interface LabReviewItem {
  /** `v<i>` for a core value, `a<i>` for an additional one: what the save names. */
  ref: string;
  label: string;
  /** As the report printed it, in its own unit. */
  value: string;
  unit: string;
  /** The value's own day; null means the report's day. */
  day: string | null;
  /** The extractor was unsure, or guessed the unit (US-12 AC16): the review says so. */
  check: boolean;
  /** The extractor's own question, such as "Was this a blood test?" (resolveLabValues).
   *  The review shows it and leaves the value unticked. */
  question?: string;
}

export interface LabReview {
  isLabReport: boolean;
  /** The report's day when it printed a full one; null asks the user to pick. */
  reportDay: string | null;
  items: LabReviewItem[];
  /** Rows the server would not convert (US-12 AC15), named for "Not saved". */
  notSaved: Array<{ label: string; reason: string }>;
  /** Rows the extractor could not read at all (US-12 AC8). */
  unreadCount: number;
}

const ownDay = (recordedAt: string | undefined, now: string) => validDay(recordedAt, { now });

export function labReview(extraction: Extraction, now: string): LabReview {
  const items: LabReviewItem[] = [
    ...(extraction.values ?? []).map((v, i) => ({
      ref: `v${i}`,
      label: METRIC_LABELS[v.metric] ?? v.printedName ?? v.metric,
      value: String(v.displayValue),
      unit: v.displayUnit,
      day: ownDay(v.recordedAt, now),
      check: v.confidence !== 'high' || v.unitGuessed === true,
      ...(v.question ? { question: v.question } : {}),
    })),
    ...(extraction.additionalValues ?? []).map((v, i) => ({
      ref: `a${i}`,
      label: v.printedName ?? v.name,
      value: String(v.value),
      unit: v.unit,
      day: ownDay(v.recordedAt, now),
      check: false,
    })),
  ];
  return {
    isLabReport: extraction.classification === 'lab_report',
    reportDay: ownDay(extraction.reportDate ?? undefined, now),
    items,
    notSaved: (extraction.refusedValues ?? []).map((r) => ({ label: METRIC_LABELS[r.metric] ?? r.metric, reason: r.reason })),
    unreadCount: extraction.droppedValueCount ?? 0,
  };
}

export type LabRowsResult = { ok: true; rows: BulkRow[] } | { ok: false; reason: string; message: string };

/**
 * The ticked values as bulk rows, each on its own day or the report's.
 * `reportDay` is the user's choice: a real day that has happened.
 */
export function labRows(extraction: Extraction, refs: string[], reportDay: string, now: string): LabRowsResult {
  const fallback = validDay(reportDay, { now });
  const rows: BulkRow[] = [];
  for (const ref of refs) {
    const index = Number(ref.slice(1));
    const value = ref[0] === 'v' ? extraction.values?.[index] : ref[0] === 'a' ? extraction.additionalValues?.[index] : undefined;
    if (!value || !Number.isInteger(index)) return { ok: false, reason: 'not-found', message: 'That value is not in this report.' };
    // A value with a day of its own that is not a real past day (an undated
    // column the server should have stripped) is never filed on another day.
    const day = value.recordedAt !== undefined ? ownDay(value.recordedAt, now) : fallback;
    if (!day) {
      return value.recordedAt !== undefined
        ? { ok: false, reason: 'invalid-date', message: 'A value in this report has no usable date.' }
        : { ok: false, reason: 'invalid-date', message: 'Pick the day of the test: a real day, today or before.' };
    }
    rows.push(ref[0] === 'v'
      ? { kind: 'measurement', metricType: (value as ExtractedValue).metric, value: (value as ExtractedValue).valueSI, recordedAt: day, source: 'lab_import' }
      : {
        kind: 'lab', metricName: (value as AdditionalLabValue).name, value: (value as AdditionalLabValue).value, unit: (value as AdditionalLabValue).unit,
        referenceLow: (value as AdditionalLabValue).referenceLow ?? null, referenceHigh: (value as AdditionalLabValue).referenceHigh ?? null,
        recordedAt: day, source: 'lab_import',
      });
  }
  return { ok: true, rows };
}

export interface LabSaveSummary {
  saved: number;
  /** The day already held a value: left as it was (the web's "Replace" is not in the app yet). */
  skipped: number;
  /** Refused by the record's rules: a lab unit the catalogue does not take, or a value out of range. */
  refused: Array<{ label: string; message: string }>;
}

/** What saving would do, in counts and the engine's own words. The record is not changed. */
export function labSaveSummary(file: RoadmapFile, rows: BulkRow[], now: string): LabSaveSummary {
  const result = bulkAppendValues(file, rows, now);
  return {
    saved: result.saved.length,
    skipped: result.skippedDuplicates,
    refused: [
      ...result.refused.map((r) => ({ label: r.key, message: r.message })),
      ...result.measurementRefusals.map((r) => ({ label: METRIC_LABELS[r.metricType] ?? r.metricType, message: r.message })),
    ],
  };
}
