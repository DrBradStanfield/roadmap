/**
 * Every upload word both clients show (US-52 AC8c, US-13 AC13, AC14; design
 * docs/drafts/upload-shared-engine.md section 5, the owner's exact texts). Words the review
 * already has are reused from import-review.ts, never restated. The file notices below moved
 * here from the web (UploadNotices.tsx, upload-pipeline.ts, useUploadFlow.ts) unchanged, so a
 * failed file reads the same on both clients.
 */
import { IMPORT_LIMITS } from './import-hints';
import { IMPORT_REVIEW_TEXT, KIND_WORDS, plural } from './import-review';
import type { FailDetail } from './upload-failure';
import type { FailReason, RunRefusal } from './upload-flow';
import type { UploadPlatform } from './upload-rules';
import type { DocumentType } from './validation';

/** Section 5, rows 1 to 27, by key, with the words added since; all approved by Brad 2026-11-20. */
export const UPLOAD_TEXT = {
  /** 1. `parts` already joined; with none, the count alone. */
  summaryFiles: (n: number, parts: readonly string[]) => `${plural(n, 'file')}${parts.length ? `: ${parts.join(', ')}` : ''}`,
  /** 2. Reuses the review's "already in your record". */
  partKnown: (k: number) => IMPORT_REVIEW_TEXT.alreadySaved(k),
  partLabReports: (r: number) => plural(r, 'lab report'),
  /** 4. The review's kind words ("8 clinic letters"). */
  partDocuments: (kind: DocumentType, m: number) => plural(m, ...KIND_WORDS[kind]),
  allKnown: 'Everything here is already in your record.',
  progressFiles: (d: number, n: number) => `Reading ${d} of ${n} files`,
  progressZip: (zip: string, m: number, total: number) => `${zip}: ${m} of ${total} inside`,
  stop: 'Stop',
  undatedTitle: 'This report has no date',
  /** Reused from the iPhone (LabReviewView.swift's date picker); Swift keeps its copy until its review page moves here, then it goes. */
  dayOfTest: 'Day of the test',
  failedTitle: (k: number) => `${plural(k, 'file')} not read`,
  retryAll: 'Try again',
  stoppedLine: 'Not read: you stopped the upload.',
  documentsLine: (m: number) => (m === 1 ? '1 letter or document will be saved' : `${m} letters and documents will be saved`),
  noDate: 'No date',
  setDate: 'Set the date',
  removeDate: 'Remove the date',
  filesRow: (n: number) => `Files (${n})`,
  statusKnown: 'Already in your record',
  statusWaiting: 'Waiting',
  statusReading: 'Reading',
  statusRead: 'Read',
  statusRefused: (verdict: 'tooLarge' | 'unsupported' | 'tooMany') => (verdict === 'tooLarge' ? 'Too large to read' : verdict === 'tooMany' ? OVER_LIMIT_TEXT : 'Not a PDF, photo or ZIP'),
  /** 23. Each part dropped at zero; values alone are the review's own Save. */
  saveBoth: (n: number, m: number) => (m === 0 ? IMPORT_REVIEW_TEXT.save(n) : n === 0 ? `Save ${plural(m, 'document')}` : `Save ${plural(n, 'value')} and ${plural(m, 'document')}`),
  saveWait: (k: number) => `Wait for ${plural(k, 'file')} to finish`,
  saveNothing: 'Nothing new to save',
  /** 26. Each part dropped at zero, as 23. */
  savedLine: (n: number, m: number) => `Saved ${[...(n || !m ? [plural(n, 'value')] : []), ...(m ? [plural(m, 'document')] : [])].join(' and ')}.`,
  archivedLine: (a: number) => `${plural(a, 'original file')} kept in your cloud.`,
  /** The web's done line for originals it could not store (UploadModal.tsx), byte for byte: no count. */
  unstoredLine: "The original file couldn't be stored; its details are saved.",
  /** The Save label when Save files only originals (the web's saveLabel, ReviewOverview.tsx). */
  saveOriginals: (a: number) => `Save ${plural(a, 'original')}`,
  /** Why Save waits while a report needs its day. */
  chooseDay: 'Choose the day of the test',
  /** A conflict whose Replace is on (the web shows only the ticked box). */
  replaces: 'Replaces the value in your record.',
} as const;

/** A file not fully read, as the web's notices word it (US-12 AC9); moved from UploadNotices.tsx. */
export const FILE_NOTICE_TEXT = {
  openFailed: 'Could not open it. It may be password-protected, damaged, or not a PDF, photo or .docx file.',
  tooLarge: `Too large to read. The limit is ${IMPORT_LIMITS.websiteFileMb} MB per file.`,
  truncated: 'This file is long, so only its first part was read.',
  documentOnly: 'Filed as a document. No blood test values found.',
  noValues: 'No blood test values found.',
  serverError: 'Our server could not read it. Please try again.',
  limitError: 'Not read. The daily upload limit was reached.',
  refused: 'Not read. Claude declined to read this file, so trying again will not help.',
  tooLong: 'Not read. The file is too long to read in one go.',
  picturesOnly: 'This Word file holds pictures, not text. Save it as a PDF, or upload a photo of the page.',
} as const;
/** Why Save waits while a selected value has an error (US-13 AC5); moved from ReviewTable.tsx. */
export const FIX_ERRORS_TEXT = 'Correct or clear the values with errors before saving.';
/** A busy server's notice; moved from upload-pipeline.ts. */
export const BUSY_NOTICE_TEXT = 'Not read. Our server was busy. Please try again later.';
/** A file past the pick's cap once its ZIPs are opened (US-12 AC17); moved from useUploadFlow.ts. */
export const OVER_LIMIT_TEXT = `Not read. It is over the ${IMPORT_LIMITS.websiteFiles}-file limit for one upload. Upload it separately.`;
/** The Pages build's own key or its account, not the file, so "try again" never helps: each says what
 *  to check (US-12 AC9); moved from widget-src upload-pipeline.ts, UploadNotices.tsx and byok-upload.ts. */
export const KEY_TEXT = {
  refused: 'Anthropic refused your API key. Check the key in the "Ask about your plan" panel.',
  noCredit: 'Your Anthropic account has no credit. Check its billing, then try again.',
  rateLimit: 'Not read. Your Anthropic key hit its rate limit. Wait a minute and try again.',
  missing: 'Connect your Anthropic API key (in the "Ask about your plan" panel) to process documents on this page.',
} as const;
/** A whole run's refusal (upload-flow.ts runRefused), as the web's read-failed screen says it; moved from useUploadFlow.ts. */
export const REFUSED_TEXT: Record<RunRefusal, string> = {
  dailyLimit: 'Daily upload limit reached. You can upload more tomorrow.',
  noKey: KEY_TEXT.missing,
  server: 'An error occurred while processing files. Please try again.',
};
/** An empty ZIP, or one of unsupported files, named itself (US-12 AC9); moved from useUploadFlow.ts. */
export const EMPTY_ZIP_TEXT = 'No files we can read inside this ZIP.';

/** The iPhone's lines, moved byte for byte from LabUploadSheet.swift and AppAttestClient.swift. */
export const PHONE_FAIL_TEXT = {
  /** A 422 from the reader: it declined the file or stopped short. */
  declined: 'The AI could not read this file.',
  /** A server refusal that gave no words of its own. */
  noAnswer: 'The server could not answer just now. Please try again later.',
  cannotAttest: 'Chat and lab upload need a device that can prove the app is genuine (Apple App Attest). This device cannot.',
  /** Followed by " (App Attest <stage> <code>)" when the step and code are known. */
  attestFailed: 'This iPhone could not prove the app is genuine, so nothing was sent. Please try again.',
  /** A server answer the app could not read (AppAttestClient.Failure.badResponse). */
  badAnswer: "The server's answer could not be read.",
  /** How a request failed on the way (AppAttestClient.words, its subject "The server"). */
  network: {
    timeout: 'The server took too long to answer. Please try again.',
    dropped: 'The connection dropped before the answer finished. Please try again.',
    unreachable: 'The server could not be reached. Check your connection, then try again.',
  },
} as const;

/**
 * Each failed file's line, from the words the web shows today for the same failure: a pdf.js
 * throw, a timeout and a ZIP that will not open are all "could not open" (US-12 AC9), and a
 * dropped connection is a server error, as upload-pipeline.ts files it.
 */
export const FAIL_TEXT: Record<FailReason, string> = {
  unreadable: FILE_NOTICE_TEXT.openFailed,
  bytesUnreadable: FILE_NOTICE_TEXT.openFailed,
  zipUnreadable: FILE_NOTICE_TEXT.openFailed,
  zipEmpty: EMPTY_ZIP_TEXT,
  timeout: FILE_NOTICE_TEXT.openFailed,
  busy: BUSY_NOTICE_TEXT,
  dailyLimit: FILE_NOTICE_TEXT.limitError,
  declined: FILE_NOTICE_TEXT.refused,
  tooLong: FILE_NOTICE_TEXT.tooLong,
  server: FILE_NOTICE_TEXT.serverError,
  network: FILE_NOTICE_TEXT.serverError,
  keyRefused: `Not read. ${KEY_TEXT.refused}`,
  noCredit: `Not read. ${KEY_TEXT.noCredit}`,
  keyRateLimit: KEY_TEXT.rateLimit,
  noKey: KEY_TEXT.missing,
  // The iPhone's alone; with no words of the gate's own, its fallback.
  appRefused: PHONE_FAIL_TEXT.noAnswer,
  tooLarge: PHONE_FAIL_TEXT.noAnswer,
  cannotAttest: PHONE_FAIL_TEXT.cannotAttest,
  attestFailed: PHONE_FAIL_TEXT.attestFailed,
};

/** Where the iPhone's line differs from the web's for the same reason: an AI that declined or stopped short, a server failure with no words. */
const PHONE_LINE: Partial<Record<FailReason, string>> = {
  declined: PHONE_FAIL_TEXT.declined, tooLong: PHONE_FAIL_TEXT.declined, server: PHONE_FAIL_TEXT.noAnswer,
  // A stream that ended with no last line: the connection's failure, in today's words for one.
  network: PHONE_FAIL_TEXT.network.dropped,
};

/**
 * A failed file's line (US-52 AC7e): the send's own words first, the gate's `error` text or the App
 * Attest step and code, as today's iPhone shows them; then the iPhone's words where they differ from
 * the web's (PHONE_LINE); then FAIL_TEXT.
 */
export function failLine(status: { reason: FailReason; detail?: FailDetail }, platform: UploadPlatform): string {
  const { detail, reason } = status;
  if (detail && 'message' in detail) return detail.message;
  if (detail && 'network' in detail) return PHONE_FAIL_TEXT.network[detail.network];
  if (detail) return `${PHONE_FAIL_TEXT.attestFailed} (App Attest ${detail.stage} ${detail.code})`;
  return (platform === 'phone' ? PHONE_LINE[reason] : undefined) ?? FAIL_TEXT[reason];
}
