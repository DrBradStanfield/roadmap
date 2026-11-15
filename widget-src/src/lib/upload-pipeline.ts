// The upload's web pieces: reading one file's pages, and what a file read becomes (FileResult). The flow itself is health-core's upload-flow.ts (hooks/useUploadFlow.ts).
import { resolveLabValues, type RefusedLabValue, type UnreadLabValue } from '@roadmap/health-core/lab-extraction';
import { UNIT_DEFS, reportedToCanonical } from '@roadmap/health-core/units';
import { comparatorOf } from '@roadmap/health-core/lab-limits';
import { bloodTestKeyOf } from '@roadmap/health-core/blood-tests';
import { fileVerdict, UPLOAD_LIMITS } from '@roadmap/health-core/upload-rules';
import type { UploadOutcomeKey } from '@roadmap/health-core/product-events';
import type { ExtractedValue, AdditionalLabValue, DocumentResult, LabImportResult, PageContent, UploadErrorCode } from './api-types';
import { isDocx, isLegacyDoc } from './file-kinds';
// Type only: a value import would pull the lazy upload bundle into the main one.
import type { HealthUploadAPI } from '../upload-entry';

export interface FileResult {
  fileName: string;
  reportDate: string | null;
  values: ExtractedValue[];
  additionalValues: AdditionalLabValue[];
  error?: string;
  /** Present for non-lab documents (scan results, clinic letters, etc.) */
  document?: DocumentResult;
  /** Values the extractor refused rather than guessed, listed under "Not saved" (US-12 AC15). */
  refusedValues?: RefusedLabValue[];
  /** Value rows the parse dropped, and the ones that name their test, listed under "Not saved" (US-12 AC19). */
  droppedValueCount?: number;
  unreadValues?: UnreadLabValue[];
}

/**
 * Brad D5 (US-66 AC6): an extra value named like a core test, creatinine
 * excepted (US-12 AC11), is offered as that core value. The extractor moves
 * one into a free slot; one it left is offered here. In a unit the test takes
 * it joins the core row, where a held day shows the conflict (US-13 AC3) and
 * a second reading of a day is listed as hidden (US-12 AC14). In any other
 * unit it is listed as not saved, with why (US-12 AC19).
 */
export function offerCoreExtras(result: Pick<FileResult, 'values' | 'additionalValues' | 'refusedValues'>): Pick<FileResult, 'values' | 'additionalValues' | 'refusedValues'> {
  const values = [...result.values];
  const additionalValues: FileResult['additionalValues'] = [];
  const refusedValues = [...(result.refusedValues ?? [])];
  for (const v of result.additionalValues ?? []) {
    const metric = bloodTestKeyOf(v.name);
    if (!metric || metric === 'creatinine') { additionalValues.push(v); continue; }
    const day = { ...(v.recordedAt ? { recordedAt: v.recordedAt } : null), ...(v.printedMonth ? { printedMonth: v.printedMonth } : null) };
    if (reportedToCanonical(metric, v.value, v.unit)) {
      values.push(...resolveLabValues([{ metric, value: v.value, unit: v.unit, confidence: v.confidence ?? 'high', question: v.question, printedName: v.printedName, ...day, ...comparatorOf(v) }]));
    } else {
      const { si, conventional } = UNIT_DEFS[metric].label;
      refusedValues.push({ metric, value: v.value, unit: v.unit, reason: `This test is measured in ${si === conventional ? si : `${si} or ${conventional}`}.`, ...day });
    }
  }
  return { values, additionalValues, ...(refusedValues.length ? { refusedValues } : null) };
}

export class UploadError extends Error {
  constructor(message: string, public code: UploadErrorCode) {
    super(message);
  }
}

const EXTRACT_TIMEOUT = 30_000;

/** The size cap readPages applies through fileVerdict; kept by name for the golden pins (upload-decisions.pins.test.tsx). */
export const MAX_FILE_SIZE = UPLOAD_LIMITS.web.fileBytes;

/** Why a file was not fully read (US-12 AC9). Each is also its `upload_outcome` count. */
export type FileNoticeReason = Extract<UploadOutcomeKey, 'documentOnly' | 'noValues' | 'openFailed' | 'tooLarge' | 'truncated' | 'serverError' | 'limitError' | 'refused' | 'tooLong' | 'valuesDropped' | 'picturesOnly'>;
/** `name` is the file's whole path, its identity; the list shows it short (`noticeName`).
 *  `count` is how many the notice stands for (values dropped, which the review
 *  names under "Not saved", US-13 AC13); `text` overrides the reason's. */
export interface FileNotice { name: string; reason: FileNoticeReason; count?: number; text?: string }

const LEGACY_DOC_TEXT = 'Word .doc files cannot be read. Save it as a PDF or .docx, then upload that.';

export const shortName = (fileName: string) => fileName.split('/').pop() || fileName;

export const hasValues = (r: FileResult) => r.values.length + r.additionalValues.length > 0;
/** Runs one file's read against EXTRACT_TIMEOUT; at the limit the read is told to stop (US-12 AC7b). */
function withTimeout<T>(read: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const stop = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { stop.abort(); reject(new Error('timeout')); }, EXTRACT_TIMEOUT); });
  return Promise.race([read(stop.signal), timeout]).finally(() => clearTimeout(timer));
}

/** One file's pages, or why it gave none: `failed` for the shared upload state (upload-flow.ts
 *  `convertFailed`), `note` for a file with words of its own; any other is "could not open". */
export interface Converted { pages: PageContent[]; truncated: boolean; failed?: 'unreadable' | 'timeout'; note?: FileNotice }

/** Reads one file's pages (pdf.js, image resize or .docx text). A file that will not open, or has
 *  no pages, gives none; it is never silently dropped. The size limit is checked here too: a ZIP
 *  member's listed size can be missing. `name`: the file's whole path, its identity. */
export async function readPages(upload: HealthUploadAPI, name: string, file: File): Promise<Converted> {
  const none = (note?: FileNotice, failed: 'unreadable' | 'timeout' = 'unreadable'): Converted => ({ pages: [], truncated: false, failed, ...(note ? { note } : null) });
  try {
    if (fileVerdict({ name, bytes: file.size, kind: 'file', platform: 'web' }) === 'tooLarge') return none({ name, reason: 'tooLarge' });
    if (upload.isPdf(file)) {
      const { pages, truncated } = await withTimeout((signal) => upload.extractFromPdf(file, signal));
      if (pages.length > 0) return { pages, truncated };
    } else if (upload.isImage(file)) {
      return { pages: [{ type: 'image', content: await withTimeout(() => upload.resizeImage(file, UPLOAD_LIMITS.web.photoPx)), mimeType: 'image/jpeg' }], truncated: false };
    } else if (isDocx(file)) {
      const data = await file.arrayBuffer();
      const { text, truncated, picturesOnly } = await withTimeout((signal) => upload.docxToText(data, signal));
      if (text) return { pages: [{ type: 'text', content: text }], truncated };
      if (picturesOnly) return none({ name, reason: 'picturesOnly' });
    } else if (isLegacyDoc(file)) {
      return none({ name, reason: 'openFailed', text: LEGACY_DOC_TEXT });
    }
  } catch (err) {
    // The reason is the user's, the error is pdf.js's: only the time limit is told apart.
    if (err instanceof Error && err.message === 'timeout') return none(undefined, 'timeout');
  }
  return none();
}

/** A file the server read, as a review row; values its parse refused are named (US-12 AC9). */
export function readResult(fileName: string, result: LabImportResult): { result: FileResult; notice?: FileNotice } {
  return {
    result: {
      fileName, reportDate: result.reportDate, ...offerCoreExtras(result), document: result.document ?? undefined,
      // Listed under the review's "Not saved" (US-13 AC13).
      ...(result.droppedValueCount ? { droppedValueCount: result.droppedValueCount, unreadValues: result.unreadValues } : null),
    },
    ...(result.droppedValueCount ? { notice: { name: fileName, reason: 'valuesDropped' as const, count: result.droppedValueCount } } : null),
  };
}
