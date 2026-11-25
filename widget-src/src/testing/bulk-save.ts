// Test support only, never shipped. The store's two bulk writers the web no
// longer calls (the upload saves through storage/upload-save-store.ts), kept
// word for word so the tests that seed a record with them, or pin what they
// did, run as before. They write as the store did: under the store's erase
// mark. Brad rules on the tests that still need them (lead H18).
import { bulkAppendValues, type LabUnitRefusal, type MeasurementRefusal } from '@roadmap/health-core/record-edits';
import { documentView, saveDocuments, writtenLabRows, type DocumentPayload } from '@roadmap/health-core/document-save';
import type { RecordHost } from '@roadmap/health-core/record-host';
import type { RecordSession } from '@roadmap/health-core/record-session';
import type { MeasurementSource } from '@roadmap/health-core/validation';
import type { Comparator } from '@roadmap/health-core/lab-limits';
import { sha256Blob } from '../lib/archive-payloads';
import type { ApiDocument, ApiLabValue } from '../lib/api-types';
import { recordFailure, WritesStoppedError } from '../lib/error-diagnostics';
import { countRefusedSpellings } from '../lib/refused-spellings';
import { Sentry } from '../lib/sentry';
import { RoadmapStore } from '../storage/roadmap-store';

export interface BulkLabValueInput {
  metricName: string; value: number; unit: string;
  referenceLow?: number | null; referenceHigh?: number | null;
  recordedAt: string; source?: string; correctsId?: string; comparator?: Comparator;
}
export interface BulkLabValuesResult {
  saved: ApiLabValue[]; skippedDuplicates: number; errorCount: number; refused: LabUnitRefusal[];
  measurementRefusals?: MeasurementRefusal[]; labRows?: Array<string | null>;
}
export type BulkDocumentsResult = { saved: ApiDocument[]; errorCount: number; unstored?: number };

/** The store's private session and host, which the writers below used from inside it. */
const inside = (store: RoadmapStore) => store as unknown as { session: RecordSession; host: RecordHost };

export function storeBulkSaveLabValues(store: RoadmapStore, values: BulkLabValueInput[]): BulkLabValuesResult {
  const { session } = inside(store);
  if (session.refuses()) return { saved: [], skippedDuplicates: 0, errorCount: values.length, refused: [] };
  const result = bulkAppendValues(session.file, values.map((v) => ({ kind: 'lab' as const, ...v, source: (v.source as MeasurementSource) ?? 'lab_import' })), new Date().toISOString());
  if (result.saved.length) session.edit(() => result.file);
  return { saved: result.saved as ApiLabValue[], skippedDuplicates: result.skippedDuplicates, errorCount: 0, refused: result.refused, measurementRefusals: result.measurementRefusals, labRows: writtenLabRows(result) };
}

function reportUnstored(error: unknown, backend: string): void {
  if (error instanceof WritesStoppedError) return;
  console.warn('Document file not stored');
  Sentry.captureException(recordFailure(error, 'Document file not stored'), { tags: { area: 'cloud-sync', op: 'write-document', backend } });
}

export async function storeBulkSaveDocuments(store: RoadmapStore, documents: Array<DocumentPayload<Blob>>): Promise<BulkDocumentsResult> {
  const { session, host } = inside(store);
  const erase = session.shownErase;
  if (session.refuses(erase)) return { saved: [], errorCount: documents.length };
  const { saved, unstored, commit } = await saveDocuments(session.file, documents, {
    hash: sha256Blob, stopped: () => session.refuses(erase),
    write: (ref, file) => host.store.writeDocument(ref, file),
    mimeType: (file) => file.type || '',
    onWriteError: (error) => { if (!session.refuses(erase)) reportUnstored(error, host.store.id); },
  });
  if (!session.edit(commit, erase)) return { saved: [], errorCount: documents.length };
  return { saved: saved.map(documentView), errorCount: 0, ...(unstored ? { unstored } : {}) };
}

// The data layer's copies (lib/roadmap-data.ts keeps its store private): the store it opened last.
let opened: RoadmapStore | null = null;
const create = RoadmapStore.create.bind(RoadmapStore);
RoadmapStore.create = async (...args: Parameters<typeof RoadmapStore.create>) => (opened = await create(...args));

export async function bulkSaveLabValues(values: BulkLabValueInput[]): Promise<BulkLabValuesResult> {
  if (!opened) return { saved: [], skippedDuplicates: 0, errorCount: values.length, refused: [] };
  const result = storeBulkSaveLabValues(opened, values);
  countRefusedSpellings(result.refused);
  return result;
}
export async function bulkSaveDocuments(documents: Array<DocumentPayload<Blob>>): Promise<BulkDocumentsResult> {
  return opened ? storeBulkSaveDocuments(opened, documents) : { saved: [], errorCount: documents.length };
}
