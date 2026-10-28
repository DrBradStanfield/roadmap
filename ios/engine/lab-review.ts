// The iPhone app's lab upload review (US-52 AC8): what the server proposed,
// shown for the user to tick, and the ticked values turned into health-core's
// bulk rows. The write itself is `bulkAppendValues`, the website's and the
// connector's one bulk rule (my-data.ts `labImport`). No clinical rule here.
import type { RoadmapFile } from '../../packages/health-core/src/roadmap-file';
import { bulkAppendValues, validDay, type BulkRow } from '../../packages/health-core/src/record-edits';
import { METRIC_LABELS } from '../../packages/health-core/src/mappings';
import { documentView, pendingRowsFor } from '../../packages/health-core/src/document-save';
import type { AdditionalLabValue, DocumentResult, ExtractedValue, RefusedLabValue } from '../../packages/health-core/src/lab-extraction';

/** The server's answer (`data` of POST /api/app/v1/lab-import). */
export interface Extraction {
  classification: string;
  reportDate: string | null;
  values?: ExtractedValue[];
  additionalValues?: AdditionalLabValue[];
  refusedValues?: RefusedLabValue[];
  droppedValueCount?: number;
  /** A letter, discharge summary or other document: what the web files (US-52 AC13d). */
  document?: DocumentResult | null;
}

/** A non-lab document as the review card shows it: the web's ReviewTable card (US-52 AC13d). */
export interface DocumentReview {
  /** The model's classification, shown read-only ("clinic letter"). */
  classification: string;
  title: string;
  /** A past day, else null ("Date unknown"): a month alone keeps no day, as on the web. */
  documentDate: string | null;
  /** The first 300 characters of the text, with "..." when there is more. */
  preview: string;
  /** The record already holds a document from a file of this name: the keep tick starts off. */
  alreadySaved: boolean;
  /** A metadata-only row holds these bytes (a failed save, or the connector's;
   *  US-14 AC4): the card starts from its title and date, and the original is
   *  filed behind it even when the keep tick is off, as the web archives it. */
  held: boolean;
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
  /** The document to file, when the file is not a lab report. */
  document: DocumentReview | null;
}

const ownDay = (recordedAt: string | undefined, now: string) => validDay(recordedAt, { now });

/** The web's document dedup: a live row from a file of the same name (stable across re-reads, where titles drift). */
function alreadySaved(file: RoadmapFile | null, sourceFileName: string | null): boolean {
  return !!file && !!sourceFileName && file.documents.some((d) => !d.deleted && d.sourceFileName === sourceFileName);
}

function documentReview(document: DocumentResult, now: string, file: RoadmapFile | null, sourceFileName: string | null, contentHash: string | null): DocumentReview {
  const text = document.contentMarkdown ?? '';
  // The newest metadata-only shown-document row for these bytes, as the web's card reads it.
  const held = file ? pendingRowsFor(file.documents.filter((d) => !d.deleted).map(documentView), contentHash, false)[0] : undefined;
  return {
    classification: document.classification,
    title: held?.title ?? document.title,
    documentDate: ownDay((held ? held.documentDate : document.documentDate) ?? undefined, now),
    preview: text.length > 300 ? `${text.slice(0, 300)}...` : text,
    alreadySaved: alreadySaved(file, sourceFileName),
    held: !!held,
  };
}

export function labReview(extraction: Extraction, now: string, file: RoadmapFile | null = null, sourceFileName: string | null = null, contentHash: string | null = null): LabReview {
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
    document: extraction.classification !== 'lab_report' && extraction.document
      ? documentReview(extraction.document, now, file, sourceFileName, contentHash)
      : null,
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
    const core = ref[0] === 'v' ? extraction.values?.[index] : undefined;
    const extra = ref[0] === 'a' ? extraction.additionalValues?.[index] : undefined;
    const value = core ?? extra;
    if (!value || !Number.isInteger(index)) return { ok: false, reason: 'not-found', message: 'That value is not in this report.' };
    // A value with a day of its own that is not a real past day (an undated
    // column the server should have stripped) is never filed on another day.
    const day = value.recordedAt !== undefined ? ownDay(value.recordedAt, now) : fallback;
    if (!day) {
      return value.recordedAt !== undefined
        ? { ok: false, reason: 'invalid-date', message: 'A value in this report has no usable date.' }
        : { ok: false, reason: 'invalid-date', message: 'Pick the day of the test: a real day, today or before.' };
    }
    if (core) {
      rows.push({ kind: 'measurement', metricType: core.metric, value: core.valueSI, recordedAt: day, source: 'lab_import' });
    } else if (extra) {
      rows.push({
        kind: 'lab', metricName: extra.name, value: extra.value, unit: extra.unit,
        referenceLow: extra.referenceLow ?? null, referenceHigh: extra.referenceHigh ?? null,
        recordedAt: day, source: 'lab_import',
      });
    }
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
