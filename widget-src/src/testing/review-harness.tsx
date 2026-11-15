// Test support for the upload review suites (design PR 10): the review as the suites rendered it
// before its choices moved into the shared upload state, now driven through that state. `results`
// become read files of one open upload; every cell, date and Replace the suite touches is a `chose`
// on it; Save hands the suite what health-core's save plan writes, in the shape the suites assert
// (`ReviewDecisions`, the old Save's): so each pin still checks what Save would write. Tests only.
import { useMemo, useRef, useState, type MutableRefObject } from 'react';
import { recordFromHistory } from '@roadmap/health-core/import-review';
import { transition, type UploadFile, type UploadState } from '@roadmap/health-core/upload-flow';
import { NO_CHOICES, type ChoiceChange } from '@roadmap/health-core/upload-choices';
import type { UnifiedExtractionResult } from '@roadmap/health-core/lab-extraction';
import type { FileDocument, RoadmapFile } from '@roadmap/health-core/roadmap-file';
import { uploadSavePlan } from '@roadmap/health-core/upload-plan';
import { uploadReview } from '@roadmap/health-core/upload-review';
import { uploadView } from '@roadmap/health-core/upload-view';
import type { Comparator } from '@roadmap/health-core/lab-limits';
import type { MetricType, UnitSystem } from '@roadmap/health-core/units';
import type { UploadReviewKey } from '@roadmap/health-core/product-events';
import { ReviewTable as Review } from '../components/ReviewTable';
import { UploadReviewSections } from '../components/UploadReviewSections';
import type { ApiDocument, UploadHistory } from '../lib/api-types';
import type { Grading } from '../lib/blood-test-cell';
import type { FileResult } from '../lib/upload-pipeline';

/** What the old Save handed up, rebuilt from the save plan: a file by its hash, else `#<index>`. */
export interface ReviewDecisions {
  values: Array<{ metric: string; valueSI: number; recordedAt: string; source?: 'lab_import_edited'; correctsId?: string; comparator?: Comparator; file: string }>;
  labValues: Array<{ name: string; value: number; unit: string; referenceLow?: number | null; referenceHigh?: number | null; recordedAt: string; correctsId?: string; comparator?: Comparator; file: string }>;
  documents: Array<{ documentType: string; title: string; documentDate: string | null; contentMd: string; metadata: Record<string, unknown>; sourceFileName: string | null; screeningUpdate?: { key: string; date: string }; contentHash?: string }>;
  review: Partial<Record<UploadReviewKey, number>>;
}

interface LegacyProps {
  results: FileResult[];
  history: UploadHistory;
  unitSystem: UnitSystem;
  metricUnitOverrides?: Partial<Record<MetricType, UnitSystem>>;
  onToggleFieldUnit?: (field: string) => void;
  age?: number;
  sex?: 'male' | 'female';
  grading: Grading;
  onSave: (decisions: ReviewDecisions) => void;
  onCancel: () => void;
  isSaving: boolean;
  error?: string | null;
  countsRef?: MutableRefObject<(() => Partial<Record<UploadReviewKey, number>>) | null>;
  /** Hashes, by result, when the suite gives the files their bytes' identity. */
  hashes?: Array<string | undefined>;
}

const NOW = () => new Date().toISOString();
const fileKeyOf = (hash: string | undefined, index: number) => hash || `#${index}`;

/** One result as a read file of the upload; a result with an error is a file the server could not read. */
export function readFileOf(r: FileResult, i: number, hash?: string): UploadFile {
  const base = { id: `f${i}`, name: r.fileName, bytes: 1, hash: hash ?? null, pages: { count: 1, truncated: false } };
  if (r.error) return { ...base, status: { s: 'failed', reason: 'server', attempt: 1 } };
  const lab = !(r.document && r.values.length + r.additionalValues.length === 0);
  const extraction = {
    classification: lab ? 'lab_report' : r.document!.classification, reportDate: r.reportDate,
    values: r.values, additionalValues: r.additionalValues, unrecognized: [], document: r.document ?? null,
    ...(r.refusedValues ? { refusedValues: r.refusedValues } : {}),
    ...(r.droppedValueCount ? { droppedValueCount: r.droppedValueCount, unreadValues: r.unreadValues } : {}),
  } as unknown as UnifiedExtractionResult;
  return { ...base, status: { s: 'read', extraction, choices: NO_CHOICES } };
}

/** The suite's history as the record the review judges against. */
export function recordOf(history: UploadHistory): RoadmapFile {
  const file = recordFromHistory(history.measurements, history.labValues);
  const documents: FileDocument[] = history.documents.map((d: ApiDocument) => ({
    id: d.id, title: d.title, type: d.documentType, date: d.documentDate, fileRef: d.fileRef ?? '', contentHash: d.contentHash ?? '',
    mimeType: '', extractedText: d.contentMd, addedAt: d.createdAt, metadata: d.metadata, sourceFileName: d.sourceFileName,
  }) as FileDocument);
  return { ...file, documents };
}

export function ReviewTable({ results, history, age, sex, onSave, countsRef, hashes = [], ...rest }: LegacyProps) {
  const [state, setState] = useState<UploadState>(() => ({
    phase: 'open', platform: 'web', run: 1, started: NOW(), firstRead: NOW(), files: results.map((r, i) => readFileOf(r, i, hashes[i] ?? (r as { contentHash?: string }).contentHash)),
  }));
  const record = useMemo(() => recordOf(history), [history]);
  const now = NOW();
  const review = useMemo(() => uploadReview(state, record, now, { age, sex }), [state, record, age, sex]); // eslint-disable-line react-hooks/exhaustive-deps
  // A cloud stores originals only where the suite gave a file its bytes, as the old review archived them.
  const cloud = results.some((r) => !!(r as { file?: Blob }).file);
  const view = uploadView(state, record, now, review, cloud);
  const files = 'files' in state ? state.files : [];
  const index = (id: string) => Number(id.slice(1));
  const labResults = useRef<FileResult[]>([]);
  const next = review.labFiles.map((l) => results[index(l.fileId)]);
  if (next.length !== labResults.current.length || next.some((r, i) => r !== labResults.current[i])) labResults.current = next;
  const choices = review.labFiles.map((l) => { const f = files.find((x) => x.id === l.fileId)!; return f.status.s === 'read' ? f.status.choices : NO_CHOICES; });
  const chose = (id: string, change: ChoiceChange) => setState((s) => transition(s, { type: 'chose', id, change, now: NOW() }).state);
  const save = (counts: Partial<Record<UploadReviewKey, number>>) => {
    const plan = uploadSavePlan(state, record, now, review, cloud);
    const keyOf = (id: string) => fileKeyOf(files.find((f) => f.id === id)?.hash ?? undefined, index(id));
    const decisions: ReviewDecisions = { values: [], labValues: [], documents: [], review: counts };
    // As the old Save wrote them: a day at midnight UTC, and no reference range a report did not print.
    const at = (day: string) => (day.length === 10 ? `${day}T00:00:00.000Z` : day);
    for (const { fileId, rows } of plan.labRows) for (const row of rows) {
      const limit = row.comparator ? { comparator: row.comparator } : {};
      if (row.kind === 'measurement') decisions.values.push({ metric: row.metricType, valueSI: row.value, recordedAt: at(row.recordedAt), source: row.source === 'lab_import_edited' ? row.source : undefined, correctsId: row.correctsId, ...limit, file: keyOf(fileId) });
      else decisions.labValues.push({ name: row.metricName, value: row.value, unit: row.unit, referenceLow: row.referenceLow ?? undefined, referenceHigh: row.referenceHigh ?? undefined, recordedAt: at(row.recordedAt), correctsId: row.correctsId, ...limit, file: keyOf(fileId) });
    }
    for (const d of plan.documents) {
      const update = plan.screenings.find((x) => x.fileId === d.fileId && x.ticked && x.date !== null);
      decisions.documents.push({ ...d.fields, screeningUpdate: update ? { key: update.key, date: update.date! } : undefined, contentHash: files.find((f) => f.id === d.fileId)?.hash ?? undefined });
    }
    onSave(decisions);
  };
  const documentOf = (id: string) => { const f = files.find((x) => x.id === id); return f?.status.s === 'read' ? (f.status.extraction.document as never) ?? null : null; };
  return (
    <Review {...rest} results={labResults.current} choices={choices} review={review} view={view} onChose={chose} history={history} onSave={save} countsRef={countsRef}>
      <UploadReviewSections view={view} documentOf={documentOf} failedLine={() => null} onChose={chose} onRetry={() => {}} />
    </Review>
  );
}
