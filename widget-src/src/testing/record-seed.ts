// Test support (PR 1906 fix round, item 7): the store's bulk lab and document writes are gone; their
// only callers were tests seeding a record. Lab values are seeded by health-core's one bulk rule
// (`bulkAppendValues`) in one session edit, as the deleted method did. Documents go through the
// upload's real Save (RoadmapStore.saveUpload), each payload a read letter, so a suite that pins how
// documents land (hash dedup, held rows, failed originals, the erase guard) pins production code.
// The store is the one the suite opened, or the page's (roadmap-data), caught as it is created.
// Imported by tests only.
import { NO_CHOICES } from '@roadmap/health-core/upload-choices';
import { bulkAppendValues, type BulkRow } from '@roadmap/health-core/record-edits';
import { documentView, writtenLabRows, type DocumentPayload } from '@roadmap/health-core/document-save';
import type { UnifiedExtractionResult } from '@roadmap/health-core/lab-extraction';
import type { MeasurementSource } from '@roadmap/health-core/validation';
import type { RoadmapFile } from '@roadmap/health-core/roadmap-file';
import type { UploadFile, UploadState } from '@roadmap/health-core/upload-flow';
import { RoadmapStore, type BulkLabValueInput } from '../storage/roadmap-store';
import { sha256Blob } from '../lib/archive-payloads';
import type { ApiDocument, ApiLabValue } from '../lib/api-types';

// The page's store (lib/roadmap-data keeps it to itself): the last one created.
let last: RoadmapStore | null = null;
const create = RoadmapStore.create.bind(RoadmapStore);
RoadmapStore.create = async (...args: Parameters<typeof RoadmapStore.create>) => (last = await create(...args));
const pageStore = () => {
  if (!last) throw new Error('No store open: call initRoadmapStore first');
  return last;
};

type Inner = { session: { edit(change: (file: RoadmapFile) => RoadmapFile | void, erase?: string): boolean }; refuses(erase?: string): boolean };

/** Lab values by health-core's bulk rule, in one edit: a taken slot skipped, a Replace by `correctsId`. */
export function seedStoreLabValues(store: RoadmapStore, rows: BulkLabValueInput[]) {
  const inner = store as unknown as Inner;
  if (inner.refuses()) return { saved: [] as ApiLabValue[], skippedDuplicates: 0, errorCount: rows.length, refused: [] };
  const result = bulkAppendValues(store.file, rows.map((v): BulkRow => ({ kind: 'lab', ...v, source: (v.source as MeasurementSource) ?? 'lab_import' })), new Date().toISOString());
  if (result.saved.length) inner.session.edit(() => result.file);
  return { saved: result.saved as unknown as ApiLabValue[], skippedDuplicates: result.skippedDuplicates, errorCount: 0, refused: result.refused, measurementRefusals: result.measurementRefusals, labRows: writtenLabRows(result) };
}

/** Documents through the upload's Save, each payload a read letter; with bytes, a cloud keeps them. */
export async function seedStoreDocuments(store: RoadmapStore, payloads: Array<DocumentPayload<Blob>>): Promise<{ saved: ApiDocument[]; errorCount: number; unstored?: number }> {
  const now = new Date().toISOString();
  const files: UploadFile[] = await Promise.all(payloads.map(async (p, i): Promise<UploadFile> => {
    const extraction = {
      classification: p.documentType, reportDate: null, values: [], additionalValues: [], unrecognized: [],
      document: { classification: p.documentType, title: p.title, documentDate: p.documentDate, contentMarkdown: p.contentMd, metadata: p.metadata },
    } as unknown as UnifiedExtractionResult;
    const hash = p.file ? await sha256Blob(p.file) : p.contentHash ?? null;
    // The payload's title and date are the reviewed ones, as the deleted bulk save took them: the person's fixes.
    const choices = { ...NO_CHOICES, document: { title: p.title, date: p.documentDate } };
    return { id: `seed-${i}`, name: p.sourceFileName ?? `seed-${i}.pdf`, bytes: 1, hash, pages: null, status: { s: 'read', extraction, choices } };
  }));
  const state: UploadState = { phase: 'saving', platform: 'web', run: 1, started: now, firstRead: now, attempt: 1, files };
  const blob = (id: string) => payloads[Number(id.slice('seed-'.length))]?.file;
  const before = new Set(store.file.documents.map((d) => d.id));
  const answer = await store.saveUpload(state, now, payloads.some((p) => p.file), {
    holds: (id) => !!blob(id), original: (id) => blob(id) ?? null, mimeType: (id) => blob(id)?.type ?? '',
  });
  if (!answer.ok) return { saved: [], errorCount: payloads.length };
  // The rows this Save added and left live (a same-hash row merged in meanwhile is tombstoned by it).
  const saved = store.file.documents.filter((d) => !before.has(d.id) && !d.deleted).map(documentView) as unknown as ApiDocument[];
  return { saved, errorCount: 0, ...(answer.outcome.unstored ? { unstored: answer.outcome.unstored } : {}) };
}

/** The same, on the page's store (lib/roadmap-data's). */
export const seedLabValues = async (rows: BulkLabValueInput[]) => seedStoreLabValues(pageStore(), rows);
export const seedDocuments = (payloads: Array<DocumentPayload<Blob>>) => seedStoreDocuments(pageStore(), payloads);
