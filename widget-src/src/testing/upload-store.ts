// Test support for the upload modal suites (design PR 10): the record the upload reads and the one
// Save it makes, as lib/roadmap-data gives them, in memory. Save is health-core `uploadSave` on that
// record (the code the store runs, RoadmapStore.saveUpload), so a suite checks the rows Save writes.
// A suite mocking roadmap-data spreads `uploadStoreMock()` into its mock. Imported by tests only.
import { vi } from 'vitest';
import { createEmptyFile, type FileDocument, type RoadmapFile } from '@roadmap/health-core/roadmap-file';
import type { UploadState } from '@roadmap/health-core/upload-flow';
import { uploadSave, type UploadSaveIO } from '@roadmap/health-core/upload-save';
import type { UploadStoreSave } from '../storage/roadmap-store';

const EMPTY = () => createEmptyFile({ deviceId: 'test', now: '2026-01-01T00:00:00.000Z' });

/** The record as the upload sees it, and each Save: the state it was asked with and the record it wrote. */
export const uploadStore = {
  record: EMPTY(),
  saves: [] as Array<{ state: UploadState; cloud: boolean; before: RoadmapFile; file: RoadmapFile | null }>,
  /** Stand in for a store that refuses (an erase moved, a log-off): the Save's answer. */
  refuse: null as string | null,
  /** Originals written, by ref. */
  written: new Map<string, unknown>(),
  /** A Save waits for this before it answers, so a suite can act while it runs. */
  hold: null as Promise<unknown> | null,
};

export function resetUploadStore(record: RoadmapFile = EMPTY()): void {
  Object.assign(uploadStore, { record, saves: [], refuse: null, written: new Map(), hold: null });
}

async function saveUpload(state: UploadState, _reviewed: RoadmapFile, now: string, cloud: boolean, io: Omit<UploadSaveIO<Blob>, 'write'>): Promise<UploadStoreSave> {
  if (uploadStore.hold) await uploadStore.hold;
  if (uploadStore.refuse !== null) {
    uploadStore.saves.push({ state, cloud, before: uploadStore.record, file: null });
    return { ok: false, message: uploadStore.refuse || null };
  }
  const out = await uploadSave(state, uploadStore.record, now, cloud, { ...io, write: async (ref, bytes) => void uploadStore.written.set(ref, bytes) });
  if (!out.ok) {
    uploadStore.saves.push({ state, cloud, before: uploadStore.record, file: null });
    return { ok: false, message: out.message };
  }
  const { file, outcome } = out.commit(uploadStore.record);
  uploadStore.saves.push({ state, cloud, before: uploadStore.record, file });
  uploadStore.record = file;
  return { ok: true, outcome, added: [] };
}

/** The roadmap-data functions the upload uses for its record and its Save. */
export function uploadStoreMock() {
  return { uploadRecord: () => uploadStore.record, saveUpload: vi.fn(saveUpload) };
}

/** The rows the last Save wrote that the record did not hold before it, in the shapes the suites compare. */
export function lastSaved(): { values: Array<Record<string, unknown>>; labValues: Array<Record<string, unknown>>; documents: FileDocument[] } {
  const last = uploadStore.saves.at(-1);
  const after = last?.file;
  if (!last || !after) return { values: [], labValues: [], documents: [] };
  const { before } = last;
  const known = new Set([...before.measurements, ...before.labValues, ...before.documents].map((r) => r.id));
  const fresh = <T extends { id: string }>(rows: T[]) => rows.filter((r) => !known.has(r.id));
  const strip = ({ createdAt: _c, updatedAt: _u, lamport: _l, deviceId: _d, lastDeviceId: _ld, ...rest }: Record<string, unknown>) => rest;
  return {
    values: fresh([...after.measurements, ...after.labValues.filter((l) => l.core)] as Array<{ id: string } & Record<string, unknown>>).map(strip),
    labValues: fresh(after.labValues.filter((l) => !l.core) as unknown as Array<{ id: string } & Record<string, unknown>>).map(strip),
    documents: fresh(after.documents),
  };
}
