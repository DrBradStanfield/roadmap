// Test support: the shipped upload Save, driven with a pick built from plain rows, so a test pins what a person's
// upload does: `RoadmapStore.saveUpload` (storage/upload-save-store.ts `saveUploadThrough`) or the data layer's
// `saveUpload` over it. Each file is read as the reader would hand it over: a letter or document, or a lab report's
// values on one day. Imported by tests only.
import type { Comparator } from '@roadmap/health-core/lab-limits';
import type { UnifiedExtractionResult } from '@roadmap/health-core/lab-extraction';
import type { RoadmapFile } from '@roadmap/health-core/roadmap-file';
import { NO_CHOICES, type FileChoices } from '@roadmap/health-core/upload-choices';
import type { UploadFile, UploadState } from '@roadmap/health-core/upload-flow';
import { reviewedWrites, uploadReview } from '@roadmap/health-core/upload-review';
import { uploadSave } from '@roadmap/health-core/upload-save';
import { sha256Blob } from '../lib/archive-payloads';
import { emptyHeld } from '../lib/upload-read';
import { webUploadIO } from '../lib/upload-save-io';
import type { RoadmapStore } from '../storage/roadmap-store';
import type { UploadSaveAnswer, WebSaving, WebUploadIO } from '../storage/upload-save-store';

export const ENGINE = { uploadSave, uploadReview };

/** A letter or document the reader found in one file. `file`: its original, held by the page. */
export interface PickedDocument {
  documentType: string; title: string; documentDate: string | null; contentMd?: string;
  metadata?: Record<string, unknown>; sourceFileName: string; file?: Blob; contentHash?: string;
}
/** A lab report's values on one day. `file`: its original, held by the page. */
export interface PickedReport {
  report: string; reportDate: string; file?: Blob; contentHash?: string;
  /** The person's choices on the review, as `a<i>` names the i-th value (a Replace: `replace: { a0: heldRowId }`). */
  choices?: Partial<FileChoices>;
  values: Array<{ name: string; value: number; unit: string; referenceLow?: number | null; referenceHigh?: number | null; comparator?: Comparator }>;
}
export type Picked = PickedDocument | PickedReport;

export interface PickOptions {
  now?: string;
  /** The erase the page showed at the press on Save, which the saving state carries (absent: `stamped` adds the erase
   *  the store shows as the Save runs). */
  erase?: string;
}

const extractionOf = (p: Picked): UnifiedExtractionResult => ('report' in p
  ? { classification: 'lab_report', reportDate: p.reportDate, values: [], unrecognized: [], document: null, additionalValues: p.values.map((v) => ({ ...v })) }
  : { classification: p.documentType, reportDate: null, values: [], additionalValues: [], unrecognized: [],
    document: { classification: p.documentType, title: p.title, documentDate: p.documentDate, contentMarkdown: p.contentMd ?? '', metadata: p.metadata ?? {} } });

/** The pick as Save starts it on `record`, the reviewed page's writes echoed as the flow sends them, and what the page
 *  holds of it. A file's hash is its bytes' (as the read takes it), else the given one, else none. */
export async function pickOf(record: RoadmapFile, picked: Picked[], { now = new Date().toISOString(), erase }: PickOptions = {}): Promise<{ s: UploadState; io: WebUploadIO }> {
  const held = emptyHeld(1);
  const files: UploadFile[] = [];
  for (const [i, p] of picked.entries()) {
    const id = `f${i}`;
    const name = 'report' in p ? p.report : p.sourceFileName;
    const hash = p.file ? await sha256Blob(p.file) : p.contentHash ?? null;
    if (p.file) held.files.set(id, { file: p.file instanceof File ? p.file : new File([p.file], name, { type: p.file.type }) });
    files.push({ id, name, bytes: p.file?.size ?? 1, hash, pages: { count: 1, truncated: false }, status: { s: 'read', extraction: extractionOf(p), choices: { ...NO_CHOICES, ...('report' in p ? p.choices : {}) } } });
  }
  const open: UploadState = { phase: 'open', platform: 'web', run: 1, files, started: now, firstRead: now };
  const s: UploadState = { ...open, phase: 'saving', attempt: 1, reviewed: reviewedWrites(uploadReview(open, record, now)), ...(erase !== undefined ? { erase } : {}) };
  return { s, io: webUploadIO(held) };
}

/** The saving state as the web's Save takes it, its erase required (R5): the one it carries, else `shown`, the erase
 *  the store shows as the Save runs, which the store's own mark answered before R5. */
export function stamped(s: UploadState, shown: string): WebSaving {
  if (s.phase !== 'saving') throw new Error(`not a saving state: ${s.phase}`);
  return { ...s, erase: s.erase ?? shown };
}

/** Each lab the review shows as not saved for its unit or number, the list the data layer's Save counts (roadmap-data.ts
 *  saveUpload `refused`). */
export async function refusedLabs(record: RoadmapFile, picked: Picked[], now = new Date().toISOString()) {
  const { s } = await pickOf(record, picked, { now });
  return uploadReview(s, record, now).classification.values
    .flatMap((v) => (v.group === 'notSaved' && v.refusal && 'lab' in v.refusal ? [v.refusal.lab] : []));
}

/** Save `picked` through `store`'s upload Save. `cloud`: originals are kept (default), as a connected page keeps them. */
export async function uploadThrough(store: RoadmapStore, picked: Picked[], opts: PickOptions & { cloud?: boolean } = {}): Promise<UploadSaveAnswer> {
  const now = opts.now ?? new Date().toISOString();
  const { s, io } = await pickOf(store.file, picked, { ...opts, now });
  return store.saveUpload(ENGINE, stamped(s, store.shownErase), now, opts.cloud ?? true, io);
}

/** Save `picked` through the data layer's upload Save, on the record it holds open. */
export async function uploadOpen(picked: Picked[], opts: PickOptions = {}): Promise<UploadSaveAnswer> {
  const { getShownErase, recordFileSync, saveUpload } = await import('../lib/roadmap-data');
  const record = recordFileSync();
  if (!record) throw new Error('no record open');
  const now = opts.now ?? new Date().toISOString();
  const { s, io } = await pickOf(record, picked, { ...opts, now });
  return saveUpload(ENGINE, stamped(s, getShownErase()), now, io);
}
