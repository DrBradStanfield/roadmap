/**
 * The web's upload screens, read from the shared upload state (health-core upload-flow.ts, design
 * docs/drafts/upload-shared-engine.md PR 9) and what the web holds beside it: each file's bytes and
 * pages, by file id (the design's platform port), and the pick's own counts. Every fact about a file
 * (why it failed, whether the run was refused) is the state's. Pure: the hook (hooks/useUploadFlow.ts)
 * runs the effects; this says what the modal shows and what the review and save are handed, in the
 * shapes they took before (FileResult, FileNotice). A transitional adapter: the review-page PR
 * (design PR 10) draws the web from health-core's uploadView instead.
 */
import { inFlight, type FailReason, type UploadFile, type UploadState } from '@roadmap/health-core/upload-flow';
import { zipMemberName } from '@roadmap/health-core/lab-extraction';
import { UPLOAD_LIMITS } from '@roadmap/health-core/upload-rules';
import type { KnownIndex } from '@roadmap/health-core/upload-known';
import { BUSY_NOTICE_TEXT, EMPTY_ZIP_TEXT, FAIL_TEXT, OVER_LIMIT_TEXT, REFUSED_TEXT } from '@roadmap/health-core/upload-text';
import type { LabImportResult, PageContent } from './api-types';
import { readResult, shortName, type FileNotice, type FileNoticeReason, type FileResult } from './upload-pipeline';

export const MAX_FILES = UPLOAD_LIMITS.web.filesPerPick; // also the server's per-IP daily limit (US-12 AC17)

/** One file as the web holds it: its bytes (`file`, or `entry` for a ZIP member, inflated when read),
 *  its pages while it waits to be sent, and `note`, the words for a file that gave no pages when it
 *  has its own (a .docx of pictures, a legacy .doc, a member too large once inflated). */
export interface HeldFile {
  file?: File;
  entry?: { async(type: 'blob'): Promise<Blob> };
  pages?: PageContent[];
  note?: FileNotice;
}

/** One pick as the web holds it. `leftOut`: files past MAX_FILES; `docx`: .docx files picked, oversize
 *  too (US-12 AC13); `known`: the record's files by content, read once per pick (US-12 AC27). */
export interface Held { run: number; leftOut: number; docx: number; known: KnownIndex | null; files: Map<string, HeldFile> }

export const emptyHeld = (run = 0): Held => ({ run, leftOut: 0, docx: 0, known: null, files: new Map() });

/** The modal's screens, as before: the read and the review are one `open` state in core. */
export type UploadPhase = 'picking' | 'reading' | 'readFailed' | 'reviewing' | 'saving' | 'saveFailed' | 'done';
export type Progress = { current: number; total: number; fileName: string };

export const NO_READABLE_TEXT = 'No readable files found.';
export const NO_FILES_TEXT = 'No readable files found. Please check your files and try again.';

/** A file's whole path: a ZIP member's is its ZIP's name, then its path (`labs.zip/results.pdf`). */
export const fileNameOf = (f: UploadFile) => (f.zip !== undefined ? zipMemberName(f.zip, f.name) : f.name);

/** A file the server answered without a read (or the daily limit stopped), as the web names it: the
 *  notice's reason, which is also its `upload_outcome` count (US-12 AC9, AC10), and its own words
 *  where the reason has more than one. Only these, and read files, reach the review. */
const UNREAD: Partial<Record<FailReason, { reason: FileNoticeReason; text?: string }>> = {
  busy: { reason: 'serverError', text: BUSY_NOTICE_TEXT },
  dailyLimit: { reason: 'limitError' },
  declined: { reason: 'refused' },
  tooLong: { reason: 'tooLong' },
  server: { reason: 'serverError' },
  network: { reason: 'serverError' },
  keyRefused: { reason: 'serverError', text: FAIL_TEXT.keyRefused },
  noCredit: { reason: 'serverError', text: FAIL_TEXT.noCredit },
  keyRateLimit: { reason: 'limitError', text: FAIL_TEXT.keyRateLimit },
};
const reached = (f: UploadFile) => f.status.s === 'read' || (f.status.s === 'failed' && UNREAD[f.status.reason] !== undefined);
const badZip = (f: UploadFile) => f.status.s === 'failed' && (f.status.reason === 'zipUnreadable' || f.status.reason === 'zipEmpty');
const filesOf = (s: UploadState) => (s.phase === 'choosing' ? [] : s.files);

/** The screen a state shows. `open` is reading while anything is in flight, then the review once a
 *  file reached the server, is already held or was stopped; a pick of only files too large stays on the dropzone. */
export function phaseOf(s: UploadState): UploadPhase {
  switch (s.phase) {
    case 'choosing': case 'consent': return 'picking';
    case 'failed': return 'readFailed';
    case 'saving': case 'saveFailed': case 'done': return s.phase;
    case 'open':
      if (inFlight(s) > 0) return 'reading';
      // A file the person stopped is their choice, not a failed read: the list stays and names it (US-12 AC28).
      if (s.files.some((f) => reached(f) || f.status.s === 'known' || f.status.s === 'stopped')) return 'reviewing';
      return s.files.every((f) => f.status.s === 'refused') ? 'picking' : 'readFailed';
  }
}

/** The read-failed screen's message: the run's refusal, else no readable file (a pick of only ZIPs that gave none says it short). */
export function readErrorOf(s: UploadState): string | null {
  if (phaseOf(s) !== 'readFailed') return null;
  if (s.phase === 'failed' && s.refused) return REFUSED_TEXT[s.refused];
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

/** The Pages build's missing key refused the run: it names and counts nothing (US-12 AC10). */
export const refusedForKey = (s: UploadState) => s.phase === 'failed' && s.refused === 'noKey';

/** A cancelled run's notices, counted on the pick's basis (US-12 AC10): the picked files too large, and those left out. */
export function pickNotices(s: UploadState, held: Held): FileNotice[] {
  const large = filesOf(s).filter((f) => f.zip === undefined && f.status.s === 'refused' && f.status.verdict === 'tooLarge');
  return [...large.map((f): FileNotice => ({ name: f.name, reason: 'tooLarge' })), ...(held.leftOut > 0 ? [leftOutNotice(held.leftOut)] : [])];
}

/** What the web alone knows of a pick, said beside the list (US-12 AC9, AC13): each file's own words for why it gave no
 *  pages (a legacy .doc, a .docx of pictures, a ZIP member too large once inflated), and the files left out past
 *  MAX_FILES. The shared state holds neither. */
export function heldNotices(s: UploadState, held: Held): FileNotice[] {
  if (held.run !== s.run) return [];
  const notes = filesOf(s).flatMap((f) => (f.status.s === 'failed' && held.files.get(f.id)?.note ? [held.files.get(f.id)!.note!] : []));
  return [...notes, ...(held.leftOut > 0 ? [leftOutNotice(held.leftOut)] : [])];
}

/** What one file gives the review and its notices, in the shapes the review took before. */
function outcomeOf(f: UploadFile, h: HeldFile | undefined): { result?: FileResult; notices: FileNotice[] } {
  const name = fileNameOf(f);
  const truncated: FileNotice[] = f.pages?.truncated ? [{ name, reason: 'truncated' }] : [];
  const st = f.status;
  switch (st.s) {
    case 'refused':
      return { notices: st.verdict === 'tooLarge' ? [{ name, reason: 'tooLarge' }] : st.verdict === 'tooMany' ? [{ name, reason: 'limitError', text: OVER_LIMIT_TEXT }] : [] };
    case 'read': {
      const { result, notice } = readResult(name, st.extraction as unknown as LabImportResult);
      return { result, notices: [...truncated, ...(notice ? [notice] : [])] };
    }
    case 'failed': {
      const unread = UNREAD[st.reason];
      if (unread) {
        const result: FileResult = { fileName: name, reportDate: null, values: [], additionalValues: [], error: FAIL_TEXT[st.reason] };
        return { result, notices: [...truncated, { name, ...unread }] };
      }
      if (st.reason === 'noKey') return { notices: [] }; // the run's own message says it
      if (st.reason === 'zipEmpty') return { notices: [{ name, reason: 'openFailed', text: EMPTY_ZIP_TEXT }] };
      return { notices: [h?.note ?? { name, reason: 'openFailed' }] };
    }
    default: return { notices: [] }; // in flight, stopped, or already held: never shown (US-12 AC27)
  }
}

/** Every file's result and notice, in picked order (US-12 AC23), then the files left out, then the
 *  read files that gave no values (a file whose only values were refused is said under "Not saved", AC15). */
export function readOutcome(s: UploadState, held: Held): { results: FileResult[]; notices: FileNotice[] } {
  const results: FileResult[] = [];
  const notices: FileNotice[] = [];
  for (const f of filesOf(s)) {
    const out = outcomeOf(f, held.files.get(f.id));
    if (out.result) results.push(out.result);
    notices.push(...out.notices);
  }
  if (held.leftOut > 0) notices.push(leftOutNotice(held.leftOut));
  for (const r of results) {
    if (!r.error && r.values.length + r.additionalValues.length === 0 && !r.refusedValues?.length) notices.push({ name: r.fileName, reason: r.document ? 'documentOnly' : 'noValues' });
  }
  return { results, notices };
}
