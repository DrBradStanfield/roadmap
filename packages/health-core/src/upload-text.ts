/**
 * Every upload word both clients show (US-52 AC8c, US-13 AC13, AC14; design
 * docs/drafts/upload-shared-engine.md section 5, the owner's exact texts). Words the review
 * already has are reused from import-review.ts, never restated. The file notices below moved
 * here from the web (UploadNotices.tsx, upload-pipeline.ts, useUploadFlow.ts) unchanged, so a
 * failed file reads the same on both clients.
 */
import { IMPORT_LIMITS } from './import-hints';
import { IMPORT_REVIEW_TEXT, KIND_WORDS, plural } from './import-review';
import type { FailReason } from './upload-flow';
import type { DocumentType } from './validation';

/** Section 5, rows 1 to 27, by key. */
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
  statusRefused: (verdict: 'tooLarge' | 'unsupported') => (verdict === 'tooLarge' ? 'Too large to read' : 'Not a PDF, photo or ZIP'),
  /** 23. Each part dropped at zero; values alone are the review's own Save. */
  saveBoth: (n: number, m: number) => (m === 0 ? IMPORT_REVIEW_TEXT.save(n) : n === 0 ? `Save ${plural(m, 'document')}` : `Save ${plural(n, 'value')} and ${plural(m, 'document')}`),
  saveWait: (k: number) => `Wait for ${plural(k, 'file')} to finish`,
  saveNothing: 'Nothing new to save',
  /** 26. Each part dropped at zero, as 23. */
  savedLine: (n: number, m: number) => `Saved ${[...(n || !m ? [plural(n, 'value')] : []), ...(m ? [plural(m, 'document')] : [])].join(' and ')}.`,
  archivedLine: (a: number) => `${plural(a, 'original file')} kept in your cloud.`,
  /** The web's done line for originals it could not store (UploadModal.tsx), byte for byte: no count. */
  unstoredLine: "The original file couldn't be stored; its details are saved.",
} as const;

/**
 * NOT YET APPROVED: words section 5 does not have, waiting for the owner's yes (listed in PR 8).
 * saveOriginals: the Save label when Save files only originals (the web's saveLabel says
 * "Save 2 originals" today, ReviewOverview.tsx). chooseDay: why Save waits while a report needs
 * its day. replaces: a conflict whose Replace is on (the web shows only the ticked box). The dropped-at-zero forms of rows 23 and 26 ("Save 2 documents", "Saved 3 values.")
 * live in UPLOAD_TEXT.saveBoth and savedLine and wait for the same yes.
 */
export const UPLOAD_TEXT_PROPOSED = {
  saveOriginals: (a: number) => `Save ${plural(a, 'original')}`,
  chooseDay: 'Choose the day of the test',
  replaces: 'Replaces the value in your record.',
} as const;

/** Every proposed string, for the owner to show Brad: the two above and the dropped-at-zero forms of rows 23 and 26. */
export const PROPOSED_WORDS: readonly string[] = [
  UPLOAD_TEXT_PROPOSED.saveOriginals(1), UPLOAD_TEXT_PROPOSED.saveOriginals(2), UPLOAD_TEXT_PROPOSED.chooseDay, UPLOAD_TEXT_PROPOSED.replaces,
  UPLOAD_TEXT.saveBoth(0, 1), UPLOAD_TEXT.saveBoth(0, 2), UPLOAD_TEXT.savedLine(1, 0), UPLOAD_TEXT.savedLine(2, 0), UPLOAD_TEXT.savedLine(0, 1), UPLOAD_TEXT.savedLine(0, 2),
];

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
/** An empty ZIP, or one of unsupported files, named itself (US-12 AC9); moved from useUploadFlow.ts. */
export const EMPTY_ZIP_TEXT = 'No files we can read inside this ZIP.';

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
};
