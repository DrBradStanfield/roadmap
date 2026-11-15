/**
 * The web's upload screens, read from the shared upload state (health-core upload-flow.ts, design
 * docs/drafts/upload-shared-engine.md PR 9) and what the web holds beside it: each file's bytes,
 * pages and the server's words, by file id (the design's platform port). Pure: the hook
 * (hooks/useUploadFlow.ts) runs the effects; this says what the modal shows and what the review
 * and save are handed, in the shapes they took before (FileResult, FileNotice).
 */
import { inFlight, type FailReason, type UploadFile, type UploadState } from '@roadmap/health-core/upload-flow';
import { zipMemberName } from '@roadmap/health-core/lab-extraction';
import { UPLOAD_LIMITS } from '@roadmap/health-core/upload-rules';
import { EMPTY_ZIP_TEXT } from '@roadmap/health-core/upload-text';
import type { LabImportResult, PageContent, UploadErrorCode } from './api-types';
import { readResult, shortName, unreadResult, type FileNotice, type FileResult } from './upload-pipeline';

export const MAX_FILES = UPLOAD_LIMITS.web.filesPerPick; // also the server's per-IP daily limit (US-12 AC17)

/** One file as the web holds it. `entry`: a ZIP member not yet inflated. `note`: the words for a
 *  file that gave no pages, when it has its own. `failure`: the server's own code and words for a
 *  file it did not read, which name it as they did before (`sendFailed` carries only the shared code). */
export interface HeldFile {
  file?: File;
  entry?: { async(type: 'blob'): Promise<Blob> };
  pages?: PageContent[];
  note?: FileNotice;
  failure?: { code: UploadErrorCode; error: string };
}

/** A run the quota check or the upload bundle ended before any read: its message, and the reason
 *  each file not read is named with (null: none, as the Pages build's missing key names no file). */
export interface RunStop { message: string; reason: 'limitError' | 'serverError' | null }

/** One pick as the web holds it. `leftOut`: files past MAX_FILES; `docx`: .docx files picked, oversize too (US-12 AC13). */
export interface Held { run: number; leftOut: number; docx: number; stopped: RunStop | null; files: Map<string, HeldFile> }

export const emptyHeld = (run = 0): Held => ({ run, leftOut: 0, docx: 0, stopped: null, files: new Map() });

/** The modal's screens, as before: the read and the review are one `open` state in core. */
export type UploadPhase = 'picking' | 'reading' | 'readFailed' | 'reviewing' | 'saving' | 'saveFailed' | 'done';
export type Progress = { current: number; total: number; fileName: string };

export const NO_READABLE_TEXT = 'No readable files found.';
export const NO_FILES_TEXT = 'No readable files found. Please check your files and try again.';

/** A file's whole path: a ZIP member's is its ZIP's name, then its path (`labs.zip/results.pdf`). */
export const fileNameOf = (f: UploadFile) => (f.zip !== undefined ? zipMemberName(f.zip, f.name) : f.name);

/** The server's refusals, each with the web's code, for a file the server never answered (the daily limit stopped it). With a read, only these reach the review. */
const CODE_OF: Partial<Record<FailReason, UploadErrorCode>> = { busy: 'busy', dailyLimit: 'rate_limit', declined: 'refused', tooLong: 'too_long', server: 'server_error', network: 'network' };
const SENT = Object.keys(CODE_OF) as FailReason[];
const reached = (f: UploadFile) => f.status.s === 'read' || (f.status.s === 'failed' && SENT.includes(f.status.reason));
const badZip = (f: UploadFile) => f.status.s === 'failed' && (f.status.reason === 'zipUnreadable' || f.status.reason === 'zipEmpty');
const filesOf = (s: UploadState) => (s.phase === 'choosing' ? [] : s.files);

/** The screen a state shows. `open` is reading while anything is in flight, then the review once a
 *  file reached the server or is already held; a pick of only files too large stays on the dropzone. */
export function phaseOf(s: UploadState, held: Held): UploadPhase {
  switch (s.phase) {
    case 'choosing': case 'consent': return 'picking';
    case 'failed': return 'readFailed';
    case 'saving': case 'saveFailed': case 'done': return s.phase;
    case 'open':
      if (inFlight(s) > 0) return 'reading';
      if (held.stopped) return 'readFailed';
      if (s.files.some((f) => reached(f) || f.status.s === 'known')) return 'reviewing';
      return s.files.every((f) => f.status.s === 'refused') ? 'picking' : 'readFailed';
  }
}

/** The read-failed screen's message: the run's own, else no readable file (a pick of only ZIPs that gave none says it short). */
export function readErrorOf(s: UploadState, held: Held): string | null {
  if (phaseOf(s, held) !== 'readFailed') return null;
  if (held.stopped) return held.stopped.message;
  return filesOf(s).every((f) => f.status.s === 'refused' || badZip(f)) ? NO_READABLE_TEXT : NO_FILES_TEXT;
}

/** Files done of all to read, a listed ZIP by its members as each is read (US-12 AC1): never a timer. */
export function progressOf(s: UploadState): Progress {
  const files = filesOf(s).filter((f) => f.status.s !== 'refused');
  const total = files.length;
  const done = total - inFlight(s);
  const opening = files.find((f) => f.status.s === 'listing');
  const sending = files.find((f) => f.status.s === 'sending');
  const fileName = opening ? `Opening ${opening.name}...`
    : done > 0 ? `Processed ${done} of ${total}`
      : sending ? shortName(fileNameOf(sending)) : 'Preparing upload...';
  return { current: total ? Math.round((done / total) * 100) : 0, total: 100, fileName };
}

/** The picked files a read-failed dropzone lists, with their sizes. */
export const pickedFiles = (s: UploadState) => filesOf(s).filter((f) => f.status.s !== 'refused').map((f) => ({ name: fileNameOf(f), size: f.bytes }));

/** The files a pick held past MAX_FILES, one notice that counts them (US-12 AC9). */
export const leftOutNotice = (n: number): FileNotice => ({
  name: `${n} more file${n === 1 ? '' : 's'}`, reason: 'limitError', count: n,
  text: `Not read. One upload takes at most ${MAX_FILES} files. Upload ${n === 1 ? 'it' : 'them'} separately.`,
});

/** A file reached the server: the review has something to show. */
export const hasResults = (s: UploadState) => filesOf(s).some(reached);

/** A cancelled run's notices, counted on the pick's basis (US-12 AC10): the picked files too large, and those left out. */
export function pickNotices(s: UploadState, held: Held): FileNotice[] {
  const large = filesOf(s).filter((f) => f.zip === undefined && f.status.s === 'refused' && f.status.verdict === 'tooLarge');
  return [...large.map((f): FileNotice => ({ name: f.name, reason: 'tooLarge' })), ...(held.leftOut > 0 ? [leftOutNotice(held.leftOut)] : [])];
}

/** What one file gives the review and its notices, in the shapes the review took before. */
function outcomeOf(f: UploadFile, h: HeldFile | undefined, stopped: RunStop | null, cloud: boolean): { result?: FileResult; notices: FileNotice[] } {
  const name = fileNameOf(f);
  const truncated: FileNotice[] = f.pages?.truncated ? [{ name, reason: 'truncated' }] : [];
  const st = f.status;
  switch (st.s) {
    case 'refused': return { notices: st.verdict === 'tooLarge' ? [{ name, reason: 'tooLarge' }] : [] };
    case 'stopped': return { notices: stopped?.reason ? [{ name, reason: stopped.reason }] : [] };
    case 'read': {
      const { result, notice } = readResult(name, st.extraction as unknown as LabImportResult);
      // The original travels with its result only where the backend can archive it; its hash always (US-14 AC10).
      const file = cloud ? h?.file : undefined;
      return { result: { ...result, ...(file ? { file } : null), ...(f.hash ? { contentHash: f.hash } : null) }, notices: [...truncated, ...(notice ? [notice] : [])] };
    }
    case 'failed': {
      if (SENT.includes(st.reason)) {
        const { result, notice } = unreadResult(name, h?.failure?.code ?? CODE_OF[st.reason], h?.failure?.error ?? 'Extraction failed');
        return { result, notices: [...truncated, notice] };
      }
      if (st.reason === 'zipEmpty') return { notices: [{ name, reason: 'openFailed', text: EMPTY_ZIP_TEXT }] };
      return { notices: [h?.note ?? { name, reason: 'openFailed' }] };
    }
    default: return { notices: [] }; // in flight, or already held: never shown (US-12 AC27)
  }
}

/** Every file's result and notice, in picked order (US-12 AC23), then the files left out, then the
 *  read files that gave no values (a file whose only values were refused is said under "Not saved", AC15). */
export function readOutcome(s: UploadState, held: Held, cloud: boolean): { results: FileResult[]; notices: FileNotice[] } {
  const results: FileResult[] = [];
  const notices: FileNotice[] = [];
  for (const f of filesOf(s)) {
    const out = outcomeOf(f, held.files.get(f.id), held.stopped, cloud);
    if (out.result) results.push(out.result);
    notices.push(...out.notices);
  }
  if (held.leftOut > 0) notices.push(leftOutNotice(held.leftOut));
  for (const r of results) {
    if (!r.error && r.values.length + r.additionalValues.length === 0 && !r.refusedValues?.length) notices.push({ name: r.fileName, reason: r.document ? 'documentOnly' : 'noValues' });
  }
  return { results, notices };
}
