// Test support: a fixture builder that seeds the open record directly, for a test whose subject is something else.
// Lab rows are built by health-core's row rule (`bulkAppendValues`, the one every lab writer shares) and document rows by
// its row builder (`documentRow`); both are written into the store's working copy as a record that already held them,
// with no writer's guards. A document's original, when given, is put in the store's adapter at the ref a save files it
// under. Imported by tests only.
import { buildDocumentRef } from '@roadmap/health-core/document-path';
import { documentRow, type DocumentFields } from '@roadmap/health-core/document-rows';
import type { Comparator } from '@roadmap/health-core/lab-limits';
import { bulkAppendValues } from '@roadmap/health-core/record-edits';
import type { RecordHost } from '@roadmap/health-core/record-host';
import type { RecordSession } from '@roadmap/health-core/record-session';
import type { FileDocument, FileLabValue } from '@roadmap/health-core/roadmap-file';
import type { MeasurementSource } from '@roadmap/health-core/validation';
import { sha256Blob } from '../lib/archive-payloads';
import { RoadmapStore } from '../storage/roadmap-store';

export interface SeedLab {
  metricName: string; value: number; unit: string; recordedAt: string;
  referenceLow?: number | null; referenceHigh?: number | null; source?: string; comparator?: Comparator;
}
export type SeedDocument = Omit<DocumentFields, 'contentMd' | 'metadata'> & { contentMd?: string; metadata?: Record<string, unknown>; file?: Blob; contentHash?: string };

/** The store's private session and host, which a fixture writes through. */
const inside = (store: RoadmapStore) => store as unknown as { session: RecordSession; host: RecordHost };

function write(store: RoadmapStore, change: Parameters<RecordSession['edit']>[0]): void {
  const { session } = inside(store);
  if (!session.edit(change, session.eraseIdentity)) throw new Error('seed refused: the store is erasing');
}

/** The lab rows `values` give, on the record as it is: the rows written (a slot already taken writes none). */
export function seedLabValues(store: RoadmapStore, values: SeedLab[]): FileLabValue[] {
  const rows = values.map((v) => ({ kind: 'lab' as const, ...v, source: (v.source as MeasurementSource) ?? 'lab_import' }));
  const result = bulkAppendValues(store.file, rows, new Date().toISOString());
  write(store, () => result.file);
  return result.saved as FileLabValue[];
}

/** One document row each, with its original filed when `file` is given. */
export async function seedDocuments(store: RoadmapStore, documents: SeedDocument[]): Promise<FileDocument[]> {
  const { host } = inside(store);
  const rows: FileDocument[] = [];
  const refs = new Set(store.file.documents.map((d) => d.fileRef).filter(Boolean));
  for (const { file, contentHash, ...d } of documents) {
    const row = documentRow({ contentMd: '', metadata: {}, ...d }, {
      id: crypto.randomUUID(), contentHash: contentHash ?? (file ? await sha256Blob(file) : ''), mimeType: file?.type ?? '', addedAt: new Date().toISOString(),
    });
    if (file) {
      const ref = buildDocumentRef({ type: row.type, title: row.title, date: row.date, sourceFileName: d.sourceFileName, existingRefs: refs });
      refs.add(ref);
      await host.store.writeDocument(ref, file);
      row.fileRef = ref;
    }
    rows.push(row);
  }
  write(store, (file) => void file.documents.push(...rows));
  return rows;
}

// The data layer's record (lib/roadmap-data.ts keeps its store private): the store it opened last.
let opened: RoadmapStore | null = null;
const create = RoadmapStore.create.bind(RoadmapStore);
RoadmapStore.create = async (...args: Parameters<typeof RoadmapStore.create>) => (opened = await create(...args));
const open = () => { if (!opened) throw new Error('no record open'); return opened; };

/** As `seedLabValues`, on the record the data layer holds open. */
export const seedOpenLabValues = (values: SeedLab[]) => seedLabValues(open(), values);
/** As `seedDocuments`, on the record the data layer holds open. */
export const seedOpenDocuments = (documents: SeedDocument[]) => seedDocuments(open(), documents);
