import { labImport, labImportBatch, pollBatchStatus, checkLabImportQuota } from '../lib/upload-api';
import { useState, useRef, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { IMPORT_LIMITS, METRIC_LABELS, UNDATED_PREVIOUS, zipMemberName, type LabUnitRefusal, type MeasurementRefusal, type UnitSystem, type MetricType } from '@roadmap/health-core';
import { UPLOAD_OUTCOME_KEYS, UPLOAD_OUTCOME_MAX, type UploadOutcomeKey } from '@roadmap/health-core/product-events';
import { bulkSaveMeasurements, bulkSaveDocuments, bulkSaveLabValues, getDocumentArchiveMode, getEraseIdentity, getShownErase } from '../lib/roadmap-data';
import { trackProductEvent } from '../lib/server-api';
import type { LabImportResult, PageContent, UploadErrorCode, UploadHistory } from '../lib/api-types';
import { labUnitRefusalLine, measurementRefusalLine } from '../lib/lab-value-labels';
import { useLpaUnit } from '../lib/lpa-unit';
import type { Grading } from '../lib/blood-test-cell';
import { ReviewTable, type FileResult, type DocumentToSave, type ReviewedValue, type ReviewedLabValue } from './ReviewTable';
import { ErrorBoundary } from './ErrorBoundary';
import { attachOriginals, synthesizeLabArchiveEntries, connectorDocumentEntries, type ArchiveDocPayload } from '../lib/archive-payloads';
import { useIsMobile } from '../lib/useIsMobile';
import { Sentry } from '../lib/sentry';
import { recordFailure } from '../lib/error-diagnostics';
import { openBackendPicker, UPLOAD_STORAGE_NOTICE } from '../lib/storage-notice';
import { SHOPIFY_SURFACE } from '../lib/build-flags';
import { isDocx, isLegacyDoc } from '../lib/file-kinds';

class UploadError extends Error {
  constructor(message: string, public code: UploadErrorCode) {
    super(message);
  }
}

/** The Pages build's own key or its account, not the file, so "try again"
 *  never helps: each says what to check (US-12 AC9). */
const KEY_ERROR_MESSAGES = {
  key_refused: 'Anthropic refused your API key. Check the key in the "Ask about your plan" panel.',
  no_credit: 'Your Anthropic account has no credit. Check its billing, then try again.',
};
/** Upload-level failures only: `refused` and `too_long` are one file's notice (FILE_NOTICE_TEXT). */
const UPLOAD_ERROR_MESSAGES: Partial<Record<UploadErrorCode, string>> = {
  ...KEY_ERROR_MESSAGES,
  rate_limit: 'Daily upload limit reached. You can upload more tomorrow.',
  timeout: 'Processing took too long. Try uploading fewer files at once.',
  server_restart: 'The server restarted during processing. Please try again.',
  no_files: 'No readable files found. Please check your files and try again.',
  server_error: 'Something went wrong on the server. Please try again.',
  network: 'Network error. Please check your connection and try again.',
};
/** The Pages build reads each file with the user's own Anthropic key, browser
 *  direct: no server of ours, no daily limit, only that key's rate limit (US-12 AC9). */
const BYOK_ERROR_MESSAGES: Partial<Record<UploadErrorCode, string>> = {
  rate_limit: 'Your Anthropic key hit its rate limit. Wait a minute and try again.',
  server_error: 'Anthropic could not read these files. Please try again.',
  network: 'Could not reach Anthropic. Check your connection and try again.',
};

type ModalState = 'select' | 'processing' | 'review' | 'done' | 'error';

interface UploadModalProps {
  unitSystem: UnitSystem;
  metricUnitOverrides?: Partial<Record<MetricType, UnitSystem>>;
  onToggleFieldUnit?: (field: string) => void;
  history: UploadHistory;
  onComplete: () => void;
  onStart?: () => Promise<void>;
  onClose: () => void;
  /** `erase`: the erase the page showed as the save began (US-16 AC2a). */
  onScreeningUpdate?: (screeningKey: string, value: string, erase: string) => void;
  /** The plan's age, for the review's screening eligibility (US-06 AC5). */
  age?: number;
  sex?: 'male' | 'female';
  /** Whom the review's hints and colours grade for; null for a known minor (US-07 AC6). */
  grading: Grading;
  /** Visibility does not end the session or discard review drafts. */
  open: boolean;
  onOpen: () => void;
}

/** Floating indicator shown when modal is hidden during processing.
 *  Portaled to body for the same reason as the modal — position:fixed must
 *  resolve against the viewport, not the transform'd .health-tool ancestor. */
function FloatingUploadIndicator({ progress, state, onClick }: {
  progress: { current: number; total: number; fileName: string };
  state: ModalState | 'saving';
  onClick: () => void;
}) {
  const label = state === 'error' ? 'Upload needs attention. Click to open'
    : state === 'saving' ? 'Saving health records. Click to open'
    : state === 'done' ? 'Health records saved. Click to open'
    : state === 'review' ? 'Ready for review. Click to open'
    : 'Processing health records...';
  return createPortal((
    <div className="floating-upload-indicator" onClick={onClick} role="button" tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}>
      <div className="floating-upload-text">{label}</div>
      {state === 'processing' && (
        <div className="floating-upload-bar">
          <div className="floating-upload-fill upload-progress-fill--smooth" style={{ width: `${progress.current}%` }}>&nbsp;</div>
        </div>
      )}
    </div>
  ), document.body);
}

const BATCH_THRESHOLD = 20; // Use batch API for 20+ files; pipeline for fewer
const POLL_INTERVAL = 5000;
const FAKE_TICK_INTERVAL = 500;
const EXTRACT_TIMEOUT = 30_000;
// Max LLM calls in flight at once. Tier 2 ceiling (80K output tokens/min)
// comfortably absorbs 5 concurrent lab-report extractions (~500-1500 output
// tokens each). Scan/letter markdown conversion (~4K tokens) can overflow:
// fetchAnthropicRaw() does not retry a 429, so that file fails as a server error.
const LLM_CONCURRENCY = 5;
// Parallel pdf.js extractors. Extraction is CPU-bound on the main thread,
// so 3 workers keep the queue feeding 5 LLM workers without UI jank.
const EXTRACT_CONCURRENCY = 3;

/** Rotating status messages shown during batch processing */
const PROGRESS_MESSAGES = [
  'Analyzing health records...',
  'Reading clinical data...',
  'Extracting medical information...',
  'Processing documents...',
  'Identifying blood test values...',
  'Reviewing scan results...',
];

// Types for the upload processing bundle (loaded lazily)
interface HealthUploadAPI {
  extractFromPdf: (file: File) => Promise<{ pages: PageContent[]; truncated: boolean }>;
  isPdf: (file: File) => boolean;
  getZipEntries: (file: File) => Promise<Array<{ name: string; entry: { async: (type: 'blob') => Promise<Blob> } }>>;
  isZip: (file: File) => boolean;
  resizeImage: (file: File, maxDim: number) => Promise<string>;
  isImage: (file: File) => boolean;
  docxToText: (data: ArrayBuffer) => Promise<{ text: string; truncated: boolean; picturesOnly: boolean }>;
}

const MAX_FILES = IMPORT_LIMITS.websiteFiles; // also the server's per-IP daily limit (US-12 AC17)
const MAX_FILE_SIZE = IMPORT_LIMITS.websiteFileMb * 1024 * 1024; // the connector's hint names this number

/** Why a file was not fully read (US-12 AC9). Each is also its `upload_outcome` count. */
type FileNoticeReason = Exclude<UploadOutcomeKey, 'picked' | 'withValues' | 'docx' | 'undatedPrevious' | 'unitsGuessed' | 'unitsRefused'>;
/** `name` is the file's whole path, its identity; the list shows it short (`noticeName`).
 *  `count` is how many the notice stands for (values dropped); `text` overrides the reason's. */
interface FileNotice { name: string; reason: FileNoticeReason; count?: number; text?: string }
const FILE_NOTICE_TEXT: Record<Exclude<FileNoticeReason, 'valuesDropped'>, string> = {
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
};
const BYOK_NOTICE_TEXT: Partial<Record<FileNoticeReason, string>> = {
  serverError: 'Not read. Anthropic could not be reached or could not read it. Please try again.',
  limitError: 'Not read. Your Anthropic key hit its rate limit. Wait a minute and try again.',
};
const EMPTY_ZIP_TEXT = 'No files we can read inside this ZIP.';
const OVER_LIMIT_TEXT = `Not read. It is over the ${MAX_FILES}-file limit for one upload. Upload it separately.`;
const LEGACY_DOC_TEXT = 'Word .doc files cannot be read. Save it as a PDF or .docx, then upload that.';

function noticeText({ reason, count = 1, text }: FileNotice): string {
  if (text) return text;
  if (reason === 'valuesDropped') return `${count} value${count === 1 ? '' : 's'} could not be read.`;
  return (!SHOPIFY_SURFACE && BYOK_NOTICE_TEXT[reason]) || FILE_NOTICE_TEXT[reason];
}

const shortName = (fileName: string) => fileName.split('/').pop() || fileName;
/** A file's short name, or its whole path when another listed file shares the short one. */
const noticeName = (name: string, notices: FileNotice[]) =>
  notices.some(n => n.name !== name && shortName(n.name) === shortName(name)) ? name : shortName(name);
const hasValues = (r: FileResult) => r.values.length + r.additionalValues.length > 0;
function withTimeout<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), EXTRACT_TIMEOUT); });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** One file to read. A ZIP member's `fileName` is its ZIP's name, then its
 *  path (`labs.zip/results.pdf`): two ZIPs can hold one path, and the name is
 *  the document's `sourceFileName`, stable across uploads of the same ZIP. */
interface ReadInput { fileName: string; getFile: () => Promise<File> }

/** Reads one file's pages (pdf.js, image resize or .docx text), with the file they came
 *  from: its original travels with its result. A file that will not open, or
 *  has no pages, is noted and gives none; it is never silently dropped. The
 *  size limit is checked here too: a small ZIP can hold a member past it. */
async function readPages(upload: HealthUploadAPI, { fileName: name, getFile }: ReadInput, notices: FileNotice[]): Promise<{ pages: PageContent[]; file?: File }> {
  try {
    const file = await getFile();
    if (file.size > MAX_FILE_SIZE) {
      notices.push({ name, reason: 'tooLarge' });
      return { pages: [] };
    }
    if (upload.isPdf(file)) {
      const { pages, truncated } = await withTimeout(upload.extractFromPdf(file));
      if (truncated) notices.push({ name, reason: 'truncated' });
      if (pages.length > 0) return { pages, file };
    } else if (upload.isImage(file)) {
      return { pages: [{ type: 'image', content: await withTimeout(upload.resizeImage(file, 1200)), mimeType: 'image/jpeg' }], file };
    } else if (isDocx(file)) {
      const { text, truncated, picturesOnly } = await withTimeout(upload.docxToText(await file.arrayBuffer()));
      if (truncated) notices.push({ name, reason: 'truncated' });
      if (text) return { pages: [{ type: 'text', content: text }], file };
      if (picturesOnly) {
        notices.push({ name, reason: 'picturesOnly' });
        return { pages: [] };
      }
    } else if (isLegacyDoc(file)) {
      notices.push({ name, reason: 'openFailed', text: LEGACY_DOC_TEXT });
      return { pages: [] };
    }
  } catch { /* noted below: the reason is the user's, the error is pdf.js's */ }
  notices.push({ name, reason: 'openFailed' });
  return { pages: [] };
}

/** A file the server read, as a review row; values its parse refused are named (US-12 AC9). */
function readResult(fileName: string, result: LabImportResult, notices: FileNotice[]): FileResult {
  if (result.droppedValueCount) notices.push({ name: fileName, reason: 'valuesDropped', count: result.droppedValueCount });
  return { fileName, reportDate: result.reportDate, values: result.values, additionalValues: result.additionalValues || [], document: result.document ?? undefined, refusedValues: result.refusedValues };
}

/** The notice for a file's own error code; anything else is a server error. */
const UNREAD_REASONS: Partial<Record<UploadErrorCode, FileNoticeReason>> = { rate_limit: 'limitError', refused: 'refused', too_long: 'tooLong' };

/** A file the server did not read, named with why: the daily limit, a refusal, a cut-off answer, or anything else. */
function unreadResult(fileName: string, errorCode: UploadErrorCode | undefined, error: string, notices: FileNotice[]): FileResult {
  const keyError = errorCode === 'key_refused' || errorCode === 'no_credit' ? `Not read. ${KEY_ERROR_MESSAGES[errorCode]}` : undefined;
  notices.push({ name: fileName, reason: (errorCode && UNREAD_REASONS[errorCode]) || 'serverError', text: keyError });
  return { fileName, reportDate: null, values: [], additionalValues: [], error };
}

/** US-12 AC10: one run's counts, integers only. Never a name, unit or value.
 *  `docx` is how many of the picked files were .docx (AC13); `values` holds
 *  value counts: `undatedPrevious` from an undated previous column (AC14),
 *  `unitsGuessed` (AC16) and `unitsRefused` (AC15). A zero is never
 *  sent: every key is optional, so a server a deploy behind meets a new key
 *  only once it counts something. */
function trackUploadOutcome(picked: number, withValues: number, docx: number, notices: FileNotice[], values: Partial<Record<'undatedPrevious' | 'unitsGuessed' | 'unitsRefused', number>> = {}): void {
  const counts: Partial<Record<UploadOutcomeKey, number>> = { picked, withValues, docx, ...values };
  for (const n of notices) counts[n.reason] = (counts[n.reason] ?? 0) + (n.count ?? 1);
  trackProductEvent('upload_outcome', Object.fromEntries(
    UPLOAD_OUTCOME_KEYS.filter(k => counts[k]).map(k => [k, Math.min(counts[k]!, UPLOAD_OUTCOME_MAX)]),
  ));
}

/** Values the extractor refused rather than guessed, each with why (US-12 AC15).
 *  No unit to pick: a user sure it was a blood test types it in the table. */
function NotSaved({ results }: { results: FileResult[] }) {
  const rows = results.flatMap(r => (r.refusedValues ?? []).map(v => ({ ...v, fileName: r.fileName })));
  if (rows.length === 0) return null;
  return (
    <div className="upload-file-notices">
      <p className="upload-file-notices-title">Not saved. If one was a blood test, add it to your blood test table after saving:</p>
      <ul aria-label="Values not saved">
        {rows.map((v, i) => (
          <li key={i}><span className="upload-file-notice-name">{shortName(v.fileName)}</span> {METRIC_LABELS[v.metric as MetricType] ?? v.metric} {`${v.value} ${v.unit}`.trim()}. {v.reason}</li>
        ))}
      </ul>
    </div>
  );
}

/** The files a run did not fully read, each with its reason (US-12 AC9). */
function FileNotices({ notices }: { notices: FileNotice[] }) {
  if (notices.length === 0) return null;
  return (
    <div className="upload-file-notices">
      <p className="upload-file-notices-title">Check these files:</p>
      <ul aria-label="Files to check">
        {notices.map((n, i) => (
          <li key={i}><span className="upload-file-notice-name">{noticeName(n.name, notices)}</span> {noticeText(n)}</li>
        ))}
      </ul>
    </div>
  );
}

export function UploadModal({ unitSystem, metricUnitOverrides, onToggleFieldUnit, history, onComplete, onStart, onClose, onScreeningUpdate, age, sex, grading, open, onOpen }: UploadModalProps) {
  const [state, setState] = useState<ModalState>('select');
  const [files, setFiles] = useState<File[]>([]);
  // Connect-first gate (decision record: encourage, don't block). 'device-only'
  // + not skipped → show the connect panel instead of the dropzone.
  const archiveMode = getDocumentArchiveMode();
  const [skipArchive, setSkipArchive] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0, fileName: '' });
  const [results, setResults] = useState<FileResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notices, setNotices] = useState<FileNotice[]>([]);
  const [savedCount, setSavedCount] = useState(0);
  const [skippedMeasurements, setSkippedMeasurements] = useState(0);
  const [skippedLabValues, setSkippedLabValues] = useState(0);
  const [saveErrorCount, setSaveErrorCount] = useState(0);
  const [savedDocCount, setSavedDocCount] = useState(0);
  const [savedLabCount, setSavedLabCount] = useState(0);
  // US-21 phase 3: lab rows the record would not store because it does not know
  // that unit for that test. Shown by name — a dropped value must never be silent.
  const [refusedLabUnits, setRefusedLabUnits] = useState<LabUnitRefusal[]>([]);
  const [refusedMeasurements, setRefusedMeasurements] = useState<MeasurementRefusal[]>([]);
  // Lp(a)'s refusal names its range in the unit its field shows (US-05 AC2).
  const [lpaUnit] = useLpaUnit(unitSystem);
  const [isSaving, setIsSaving] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const savingRef = useRef(false);
  useEffect(() => () => { abortRef.current?.abort(); }, []);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isMobile = useIsMobile(768);

  const resetSession = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setState('select');
    setFiles([]);
    setResults([]);
    setError(null);
    setNotices([]);
    setProgress({ current: 0, total: 0, fileName: '' });
    setSavedCount(0);
    setSkippedMeasurements(0);
    setSkippedLabValues(0);
    setSaveErrorCount(0);
    setSavedDocCount(0);
    setSavedLabCount(0);
    setRefusedLabUnits([]);
    setRefusedMeasurements([]);
  }, []);

  // Closing active work only hides it. Drafts and pending saves remain mounted.
  const handleClose = useCallback(() => {
    if (!savingRef.current && (state === 'select' || state === 'done' || state === 'error')) {
      resetSession();
      setSkipArchive(false);
    }
    onClose();
  }, [state, onClose, resetSession]);

  const handleDiscard = useCallback(() => {
    if (savingRef.current) return;
    resetSession();
    setSkipArchive(false);
    onClose();
  }, [onClose, resetSession]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') handleClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [handleClose, open]);

  // Load the upload bundle lazily — cached promise prevents duplicate script injection
  const loadPromiseRef = useRef<Promise<HealthUploadAPI> | null>(null);
  const loadUploadBundle = useCallback((): Promise<HealthUploadAPI> => {
    if ((window as any).HealthUpload) return Promise.resolve((window as any).HealthUpload);
    if (loadPromiseRef.current) return loadPromiseRef.current;

    const root = document.getElementById('health-tool-root');
    const src = root?.dataset.uploadUrl;
    if (!src) return Promise.reject(new Error('Upload bundle URL not found'));

    loadPromiseRef.current = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.onload = () => {
        if ((window as any).HealthUpload) {
          resolve((window as any).HealthUpload);
        } else {
          loadPromiseRef.current = null;
          reject(new Error('Upload bundle loaded but HealthUpload not found'));
        }
      };
      script.onerror = () => {
        loadPromiseRef.current = null;
        reject(new Error('Failed to load upload bundle'));
      };
      document.head.appendChild(script);
    });
    return loadPromiseRef.current;
  }, []);

  const handleFileSelect = (selectedFiles: FileList | null) => {
    if (!selectedFiles) return;
    const fileArray = Array.from(selectedFiles).slice(0, MAX_FILES);
    const valid = fileArray.filter(f => f.size <= MAX_FILE_SIZE);
    const tooLarge = fileArray.filter(f => f.size > MAX_FILE_SIZE).map(f => ({ name: f.name, reason: 'tooLarge' as const }));
    const docx = fileArray.filter(isDocx).length;
    setFiles(valid);
    setError(null);
    setNotices(tooLarge);
    if (valid.length > 0) void handleProcess(valid, tooLarge, docx);
    else if (tooLarge.length > 0) trackUploadOutcome(tooLarge.length, 0, docx, tooLarge);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    handleFileSelect(e.dataTransfer.files);
  };

  const handleProcess = async (filesToProcess: File[], tooLarge: FileNotice[], docx: number) => {
    // Claim synchronously: React state alone cannot guard two selections in
    // the same render, especially while quota/draft flushing is still pending.
    if (abortRef.current || savingRef.current || filesToProcess.length === 0) return;
    const abort = new AbortController();
    abortRef.current = abort;
    setState('processing');
    setError(null);
    setProgress({ current: 0, total: 100, fileName: 'Preparing upload...' });
    const updateProgress = (p: { current: number; total: number; fileName: string }) => {
      if (!abort.signal.aborted) setProgress(p);
    };

    const fileCount = filesToProcess.length;
    // Every file the run did not fully read, oversize ones first (US-12 AC9).
    // `names` is every other file seen, by whole path: a ZIP's members once it is listed.
    const runNotices = [...tooLarge];
    let names = filesToProcess.map(f => f.name);
    /** The run failed as a whole: each file without a verdict yet gets this one.
     *  Verdicts are matched one for one, so two files on one path count twice. */
    const failUnread = (reason: 'serverError' | 'limitError') => {
      const settled = runNotices.filter(n => n.reason !== 'truncated' && n.reason !== 'valuesDropped').map(n => n.name);
      for (const name of names) {
        const i = settled.indexOf(name);
        if (i >= 0) settled.splice(i, 1);
        else runNotices.push({ name, reason });
      }
    };
    const finish = (finished: FileResult[]) => {
      let withValues = 0;
      const values = { undatedPrevious: 0, unitsGuessed: 0, unitsRefused: 0 };
      for (const r of finished) {
        if (r.error) continue;
        if (hasValues(r)) withValues++;
        // A file whose only values were refused is said under "Not saved", not "no values" (US-12 AC15).
        else if (!r.refusedValues?.length) runNotices.push({ name: r.fileName, reason: r.document ? 'documentOnly' : 'noValues' });
        values.undatedPrevious += [...r.values, ...r.additionalValues].filter(v => v.recordedAt === UNDATED_PREVIOUS).length;
        values.unitsGuessed += r.values.filter(v => v.unitGuessed).length;
        values.unitsRefused += r.refusedValues?.length ?? 0;
      }
      setNotices(runNotices);
      trackUploadOutcome(tooLarge.length + names.length, withValues, docx, runNotices, values);
    };

    try {
      const quota = await checkLabImportQuota();
      if (abort.signal.aborted) return;
      if (!quota.allowed) {
        setError(quota.message ?? 'Daily upload limit reached. You can upload more tomorrow.');
        setState('error');
        abortRef.current = null;
        return;
      }
      await onStart?.();
      if (abort.signal.aborted) return;
      trackProductEvent('upload_started', { count: fileCount });
      const upload = await loadUploadBundle();
      if (abort.signal.aborted) return;
      // A .docx is itself a ZIP, and some browsers say so: it is read as a .docx.
      const isZip = (f: File) => !isDocx(f) && upload.isZip(f);
      const zipFiles = filesToProcess.filter(isZip);
      const otherFiles = filesToProcess.filter(f => !isZip(f));

      // Every file to read, ZIP members first (named with their ZIP: `ReadInput`).
      // A ZIP that will not open, or holds nothing readable, is itself the file named.
      const inputs: ReadInput[] = [];
      names = [];
      for (const zip of zipFiles) {
        if (abort.signal.aborted) break;
        updateProgress({ current: 0, total: 100, fileName: `Opening ${zip.name}...` });
        const entries = await upload.getZipEntries(zip).catch(() => null);
        if (!entries?.length) {
          names.push(zip.name);
          runNotices.push({ name: zip.name, reason: 'openFailed', text: entries ? EMPTY_ZIP_TEXT : undefined });
          continue;
        }
        for (const { name, entry } of entries) {
          inputs.push({ fileName: zipMemberName(zip.name, name), getFile: async () => new File([await entry.async('blob')], shortName(name)) });
        }
      }
      inputs.push(...otherFiles.map(file => ({ fileName: file.name, getFile: async () => file })));
      names.push(...inputs.map(i => i.fileName));
      // A ZIP opens into more than the window counted: past MAX_FILES the server
      // refuses the whole batch, so the rest are named and sent nowhere (US-12 AC17).
      for (const { fileName } of inputs.splice(MAX_FILES)) runNotices.push({ name: fileName, reason: 'limitError', text: OVER_LIMIT_TEXT });

      if (inputs.length === 0 || abort.signal.aborted) {
        if (!abort.signal.aborted) {
          finish([]);
          setError('No readable files found.');
          setState('error');
          abortRef.current = null;
        }
        return;
      }

      // Batch path (>=20 files): extract all, then batch. Pipeline path (<20):
      // a producer extracts, a consumer sends each file to the LLM.
      const allResults = inputs.length >= BATCH_THRESHOLD
        ? await processBatch(upload, inputs, abort, updateProgress, runNotices)
        : await processPipeline(upload, inputs, abort, updateProgress, unitSystem, runNotices);
      if (abort.signal.aborted) return;
      // Each result carries its own original. It is kept only when the backend
      // can archive it: off-cloud the bytes would be stripped at save.
      const attached = getDocumentArchiveMode() === 'cloud'
        ? await attachOriginals(allResults)
        : allResults.map(r => ({ ...r, file: undefined }));
      if (abort.signal.aborted) return;
      abortRef.current = null;
      finish(attached);
      setResults(attached);
      setState('review');
    } catch (err) {
      if (!abort.signal.aborted) {
        const code = err instanceof UploadError ? err.code : 'unknown';
        console.error('Upload processing failed:', code);
        Sentry.captureException(recordFailure(err, 'Upload processing failed'), {
          tags: { feature: 'upload', uploadErrorCode: code },
        });
        trackProductEvent('upload_extract_failed');
        failUnread(code === 'rate_limit' ? 'limitError' : 'serverError');
        finish([]);
        setError((err instanceof UploadError && ((!SHOPIFY_SURFACE && BYOK_ERROR_MESSAGES[err.code]) || UPLOAD_ERROR_MESSAGES[err.code]))
          || 'An error occurred while processing files. Please try again.');
        setState('error');
        abortRef.current = null;
      }
    }
  };

  /**
   * Pipeline: producer extracts files (ZIP blob → pdf.js → pages), consumer
   * sends pages to LLM one at a time. Extraction runs ahead of LLM calls —
   * while file 1 is in the LLM (~5s), files 2-4 are being extracted client-side.
   */
  async function processPipeline(
    upload: HealthUploadAPI,
    allInputs: ReadInput[],
    abort: AbortController,
    updateProgress: (p: { current: number; total: number; fileName: string }) => void,
    us: UnitSystem,
    notices: FileNotice[],
  ): Promise<FileResult[]> {
    const totalFiles = allInputs.length;
    const queue: Array<{ fileName: string; pages: PageContent[]; file?: File }> = [];
    const allResults: FileResult[] = [];
    let completedCount = 0;
    let activeWorkers = 0;
    let feedingDone = false;
    let resolveAll: (() => void) | null = null;
    const allDone = new Promise<void>(resolve => { resolveAll = resolve; });

    function checkDone() {
      if (abort.signal.aborted) queue.length = 0;
      if (feedingDone && activeWorkers === 0 && queue.length === 0) {
        resolveAll?.();
      }
    }

    function tryStartWorker() {
      while (activeWorkers < LLM_CONCURRENCY && queue.length > 0) {
        if (abort.signal.aborted) break;
        activeWorkers++;
        const item = queue.shift()!;
        updateProgress({ current: Math.round((completedCount / totalFiles) * 100), total: 100, fileName: shortName(item.fileName) });

        // Send to LLM
        labImport(item.pages, us).then(({ result, error: importError, errorCode }) => {
          allResults.push(result
            ? { ...readResult(item.fileName, result, notices), file: item.file }
            : unreadResult(item.fileName, errorCode, importError || 'Extraction failed', notices));
        }).catch(() => {
          allResults.push(unreadResult(item.fileName, undefined, 'Processing failed', notices));
        }).finally(() => {
          completedCount++;
          activeWorkers--;
          updateProgress({
            current: Math.round((completedCount / totalFiles) * 100),
            total: 100,
            fileName: `Processed ${completedCount} of ${totalFiles}`,
          });
          tryStartWorker();
          checkDone();
        });
      }
    }

    // Producer: a pool of extractors in parallel. Sequential extraction starved
    // LLM workers (extraction ~2s vs LLM ~5s); EXTRACT_CONCURRENCY parallel
    // extractors keep the LLM queue full.
    let extractIndex = 0;
    async function extractWorker() {
      while (extractIndex < allInputs.length) {
        if (abort.signal.aborted) break;
        const input = allInputs[extractIndex++];
        const { pages, file } = await readPages(upload, input, notices);
        if (abort.signal.aborted) return;
        if (pages.length > 0) {
          queue.push({ fileName: input.fileName, pages, file });
          tryStartWorker();
        }
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(EXTRACT_CONCURRENCY, allInputs.length) }, () => extractWorker()),
    );

    feedingDone = true;
    checkDone();

    await allDone;
    if (allResults.length === 0 && !abort.signal.aborted) {
      throw new UploadError('No readable files found.', 'no_files');
    }
    return allResults;
  }

  /** Batch: send all files in one request, poll for results. For 20+ files. */
  async function processBatch(
    upload: HealthUploadAPI,
    queue: ReadInput[],
    abort: AbortController,
    updateProgress: (p: { current: number; total: number; fileName: string }) => void,
    notices: FileNotice[],
  ): Promise<FileResult[]> {
    const allFiles: Array<{ fileName: string; pages: PageContent[] }> = [];
    const originals: Array<File | undefined> = []; // by position in allFiles
    for (let i = 0; i < queue.length; i++) {
      if (abort.signal.aborted) break;
      const { fileName } = queue[i];
      updateProgress({ current: Math.round((i / queue.length) * 30), total: 100, fileName: `Reading ${shortName(fileName)}...` });
      const { pages, file } = await readPages(upload, queue[i], notices);
      if (pages.length > 0) {
        allFiles.push({ fileName, pages });
        originals.push(file);
      }
    }

    if (abort.signal.aborted) return [];
    if (allFiles.length === 0) throw new UploadError('No readable files found.', 'no_files');

    updateProgress({ current: 33, total: 100, fileName: `Analyzing ${allFiles.length} files...` });

    const { batchId, error: batchError, errorCode: batchErrorCode } = await labImportBatch(allFiles);
    if (abort.signal.aborted) return [];
    if (!batchId) throw new UploadError(batchError || 'Failed to start processing', batchErrorCode || 'server_error');

    const fileNames = allFiles.map(f => shortName(f.fileName));
    let fakeProgress = 35;
    let realCompleted = 0;
    let tickCount = 0;

    const fakeTimer = setInterval(() => {
      if (abort.signal.aborted) return;
      tickCount++;
      fakeProgress += (90 - fakeProgress) * 0.015;
      const realPct = allFiles.length > 0 ? (realCompleted / allFiles.length) * 100 : 0;
      const displayPct = Math.max(fakeProgress, realPct);
      const statusMsg = PROGRESS_MESSAGES[Math.floor(tickCount / 8) % PROGRESS_MESSAGES.length];
      const fileName = fileNames[Math.floor(tickCount / 3) % fileNames.length];
      const msg = realCompleted > 0
        ? `Processed ${realCompleted} of ${allFiles.length} — ${fileName}`
        : `${statusMsg} ${fileName}`;
      updateProgress({ current: Math.round(displayPct), total: 100, fileName: msg });
    }, FAKE_TICK_INTERVAL);

    try {
      const maxPollTime = Date.now() + 10 * 60_000;
      while (!abort.signal.aborted) {
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
        if (abort.signal.aborted) break;
        if (Date.now() > maxPollTime) throw new UploadError('Processing timed out.', 'timeout');

        const poll = await pollBatchStatus(batchId);
        realCompleted = poll.completed;
        if (poll.error) throw new UploadError(poll.error, poll.errorCode || 'server_error');

        if (poll.status === 'ended' && poll.results) {
          clearInterval(fakeTimer);
          updateProgress({ current: 100, total: 100, fileName: 'All files processed!' });
          // Each result names its request's position, so a lost or failed one
          // is reported against its own file, never "Unknown file" (US-12 AC9).
          // An old server (the deploy window) sends no index, only the order,
          // which says nothing when the counts differ: then every file is unread.
          const indexed = poll.results.some(r => typeof r.index === 'number');
          const byIndex = new Map(indexed || poll.results.length === allFiles.length
            ? poll.results.map((r, i) => [indexed ? r.index : i, r]) : []);
          return allFiles.map(({ fileName }, i) => {
            const r = byIndex.get(i);
            return r && !('errorCode' in r)
              ? { ...readResult(fileName, r, notices), file: originals[i] }
              : unreadResult(fileName, r?.errorCode, 'Extraction failed', notices);
          });
        }
      }
      return [];
    } finally {
      clearInterval(fakeTimer);
    }
  }

  const handleCancel = () => { resetSession(); };

  const handleSave = useCallback(async ({ values: selectedValues, documents, labValues, reviewed }: {
    values: ReviewedValue[];
    documents: DocumentToSave[];
    labValues: ReviewedLabValue[];
    reviewed: FileResult[];
  }) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setIsSaving(true);
    setError(null);
    // The last save's refusals belong to it: never beside a new error.
    setRefusedLabUnits([]);
    setRefusedMeasurements([]);
    const erase = getShownErase(); // the record this save was asked for
    try {
      // Save core measurements, additional lab values, and documents in parallel
      const measurements = selectedValues.map(v => ({
        metricType: v.metric,
        value: v.valueSI,
        recordedAt: v.recordedAt,
        // Per-row source: ReviewTable tags edited rows as 'lab_import_edited'
        // so we can distinguish LLM-extracted-then-user-corrected from
        // pure LLM extraction in audit analytics. Falls back to 'lab_import'.
        source: v.source ?? 'lab_import',
        // Set only when the reviewer ticked "Replace" on an occupied slot —
        // the store then corrects that row instead of skipping the upload.
        correctsId: v.correctsId,
      }));
      // Blobs travel INSIDE the payload (attached at processing time, and only
      // when the backend can archive them) — no name-keyed re-join here.
      const docPayloads: ArchiveDocPayload[] = documents.map(d => ({
        documentType: d.documentType,
        title: d.title,
        documentDate: d.documentDate,
        contentMd: d.contentMd,
        metadata: d.metadata,
        sourceFileName: d.sourceFileName,
        file: d.file,
      }));
      const covered = new Set(documents.map(d => d.sourceFileName));
      docPayloads.push(...synthesizeLabArchiveEntries(reviewed, covered));
      // A letter the connector filed metadata-only: unselected here, still archived
      // (US-35 AC8), with the title and date the review shows (US-13 AC6).
      docPayloads.push(...connectorDocumentEntries(reviewed, history.documents, covered));
      const labValuePayloads = labValues.map(lv => ({
        metricName: lv.name,
        value: lv.value,
        unit: lv.unit,
        referenceLow: lv.referenceLow,
        referenceHigh: lv.referenceHigh,
        recordedAt: lv.recordedAt,
        source: 'lab_import' as const,
        correctsId: lv.correctsId,
      }));

      // Each branch settles before the session becomes dismissible. One
      // rejected write must not release another archive that is still saving.
      // A throw is a programming error, not a store result: report it (tag
      // only — no payload, names or values) and keep the review for a retry.
      let threw = false;
      const failed = <T,>(branch: string, fallback: T) => (err: unknown) => {
        threw = true;
        Sentry.captureException(recordFailure(err, 'Upload save failed'), { tags: { area: 'upload-save', branch } });
        return fallback;
      };
      const [savedValues, savedDocs, savedLabValues] = await Promise.all([
        measurements.length > 0 ? bulkSaveMeasurements(measurements).catch(failed('measurements', { saved: [], skippedDuplicates: 0, errorCount: measurements.length, refused: [] })) : Promise.resolve({ saved: [], skippedDuplicates: 0, errorCount: 0, refused: [] }),
        docPayloads.length > 0 ? bulkSaveDocuments(docPayloads).catch(failed('documents', { saved: [], errorCount: docPayloads.length })) : Promise.resolve({ saved: [], errorCount: 0 }),
        labValuePayloads.length > 0 ? bulkSaveLabValues(labValuePayloads).catch(failed('labValues', { saved: [], skippedDuplicates: 0, errorCount: labValuePayloads.length, refused: [] })) : Promise.resolve({ saved: [], skippedDuplicates: 0, errorCount: 0, refused: [] }),
      ]);

      setSavedCount(savedValues.saved.length);
      setSkippedMeasurements(savedValues.skippedDuplicates);
      setSkippedLabValues(savedLabValues.skippedDuplicates);
      setRefusedLabUnits(savedLabValues.refused);
      setRefusedMeasurements(savedValues.refused);
      const saveErrors = savedValues.errorCount + savedLabValues.errorCount + savedDocs.errorCount;
      setSaveErrorCount(saveErrors);
      setSavedDocCount(savedDocs.saved.length);
      setSavedLabCount(savedLabValues.saved.length);
      // A save error is the only failure: it keeps the review open so a second
      // Save retries that branch (US-12 AC6). A duplicate and a refused unit or number
      // are settled outcomes — the data is already there, or the record will
      // never take it — and neither is anything a retry could change.
      const totalSaved = savedValues.saved.length + savedDocs.saved.length + savedLabValues.saved.length;
      const saveFailed = threw || saveErrors > 0;

      // Update screening dates for documents with screening mappings, unless
      // the record was erased while the save ran: the date belongs to it.
      for (const doc of getEraseIdentity() === erase ? documents : []) {
        if (doc.screeningUpdate && onScreeningUpdate) {
          onScreeningUpdate(doc.screeningUpdate.key, doc.screeningUpdate.date, erase);
        }
      }

      if (!saveFailed) {
        trackProductEvent('upload_saved', { count: totalSaved });
        setState('done');
        onComplete();
      } else {
        // Stay in review: a second Save retries idempotently (values dedup on
        // skippedDuplicates, documents on contentHash).
        if (totalSaved > 0) onComplete();
        setError(threw ? 'Some items could not be saved. Please try again.' : 'Failed to save. Please try again.');
      }
    } catch {
      setError('Failed to save. Please try again.');
    } finally {
      savingRef.current = false;
      setIsSaving(false);
    }
  }, [onComplete, onScreeningUpdate, history.documents]);

  // One report can refuse the same test on several dates; the user needs it
  // named once. A note says what to look for instead, where there is one, and
  // a unit the test takes was refused for its number, not its unit (US-21
  // AC15). Shown on the done screen and, beside the retry message, in review
  // (US-12 AC6): a refusal is settled the moment the save answers.
  const refusalLines = <>
    {[...new Map(refusedLabUnits.map(r => [`${r.key}|${r.unit}`, r])).values()].map(r => (
      <p key={`${r.key}|${r.unit}`} className="upload-done-skipped">{labUnitRefusalLine(r.key, r.unit, r.fault)}</p>
    ))}
    {[...new Map(refusedMeasurements.map(r => [`${r.metricType}|${r.reason}|${r.bound}`, r])).values()].map(r => (
      <p key={`${r.metricType}|${r.reason}|${r.bound}`} className="upload-done-skipped">{measurementRefusalLine(r, r.metricType === 'lpa' ? lpaUnit : metricUnitOverrides?.[r.metricType as MetricType] ?? unitSystem)}</p>
    ))}
  </>;

  // Portal to body so position:fixed resolves against the viewport — the
  // .health-tool container has a transform/contain that would otherwise pin
  // the modal inside the (very tall) widget root instead of the viewport.
  return <>
    {!open && state !== 'select' && <FloatingUploadIndicator progress={progress} state={isSaving ? 'saving' : error || saveErrorCount > 0 ? 'error' : state} onClick={onOpen} />}
    {createPortal((
    <div className="upload-modal-backdrop" data-clarity-mask="true" style={!open ? { display: 'none' } : undefined} onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}>
      <div className={`upload-modal${isMobile ? ' upload-modal--mobile' : ''}`}>
        <div className="upload-modal-header">
          <h3>Upload Health Records</h3>
          <button className="upload-modal-close" onClick={handleClose} aria-label="Close">&times;</button>
        </div>

        <div className="upload-modal-body">
          {(state === 'select' || state === 'error') && archiveMode === 'device-only' && !skipArchive && (
            <div className="upload-select upload-connect-first">
              <h3 className="upload-connect-title">Keep your original documents</h3>
              <p className="upload-connect-text">{UPLOAD_STORAGE_NOTICE}</p>
              <button
                type="button"
                className="upload-btn-primary"
                onClick={() => {
                  onClose();
                  openBackendPicker();
                }}
              >
                Choose where to keep it
              </button>
              <button type="button" className="upload-connect-skip" onClick={() => setSkipArchive(true)}>
                Continue without keeping my files ›
              </button>
            </div>
          )}
          {(state === 'select' || state === 'error') && (archiveMode !== 'device-only' || skipArchive) && (
            <div className="upload-select">
              <div
                className="upload-dropzone"
                onDrop={handleDrop}
                onDragOver={(e) => e.preventDefault()}
                onClick={() => fileInputRef.current?.click()}
              >
                <div className="upload-dropzone-icon">&#128196;</div>
                <p className="upload-dropzone-text">Drop health records here, or click to browse</p>
                <p className="upload-dropzone-hint">PDF, JPG, PNG, DOCX, or ZIP &mdash; up to {MAX_FILES} files</p>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.jpg,.jpeg,.png,.docx,.doc,.zip"
                multiple
                onChange={(e) => handleFileSelect(e.target.files)}
                style={{ display: 'none' }}
              />
              {files.length > 0 && (
                <div className="upload-file-list">
                  {files.map((f, i) => (
                    <div key={i} className="upload-file-item">
                      <span>{f.name}</span>
                      <span className="upload-file-size">{(f.size / 1024).toFixed(0)} KB</span>
                    </div>
                  ))}
                </div>
              )}
              {error && <p className="upload-error">{error}</p>}
              <FileNotices notices={notices} />
            </div>
          )}

          {state === 'processing' && (
            <div className="upload-processing">
              <div className="upload-progress-bar">
                <div
                  className="upload-progress-fill upload-progress-fill--smooth"
                  style={{ width: `${progress.current}%` }}
                >&nbsp;</div>
              </div>
              <p className="upload-progress-file">{progress.fileName}</p>
              <button className="btn-primary upload-cancel-btn" onClick={handleCancel}>
                Cancel
              </button>
            </div>
          )}

          {state === 'review' && <><FileNotices notices={notices} /><NotSaved results={results} /></>}
          {state === 'review' && (
            // A review that throws while rendering is never a dead widget (US-13 AC9).
            <ErrorBoundary feature="upload_review" fallback={
              <div className="upload-review-error" role="alert">
                <p>Something went wrong showing these results. Your file was read; please try again.</p>
                <button type="button" className="btn-primary" onClick={handleDiscard}>Cancel</button>
              </div>
            }>
            <ReviewTable
              results={results}
              history={history}
              unitSystem={unitSystem}
              metricUnitOverrides={metricUnitOverrides}
              onToggleFieldUnit={onToggleFieldUnit}
              age={age}
              sex={sex}
              grading={grading}
              onSave={handleSave}
              onCancel={handleDiscard}
              isSaving={isSaving}
              error={error}
              refusals={refusedLabUnits.length + refusedMeasurements.length > 0 ? refusalLines : undefined}
            />
            </ErrorBoundary>
          )}

          {state === 'done' && (
            <div className="upload-done">
              <div className="upload-done-icon">&#10003;</div>
              <p className="upload-done-text">
                {savedCount > 0 && `Saved ${savedCount} blood test value${savedCount !== 1 ? 's' : ''}`}
                {savedCount > 0 && (savedLabCount > 0 || savedDocCount > 0) && ', '}
                {savedLabCount > 0 && `${savedLabCount} additional lab value${savedLabCount !== 1 ? 's' : ''}`}
                {savedLabCount > 0 && savedDocCount > 0 && ', '}
                {savedDocCount > 0 && `${savedDocCount} document${savedDocCount !== 1 ? 's' : ''}`}
                {savedCount === 0 && savedLabCount === 0 && savedDocCount === 0
                  && skippedMeasurements === 0 && skippedLabValues === 0 && saveErrorCount === 0
                  && refusedLabUnits.length === 0 && refusedMeasurements.length === 0 && 'No items saved'}
              </p>
              {skippedMeasurements > 0 && (
                <p className="upload-done-skipped">
                  {skippedMeasurements} blood test value{skippedMeasurements !== 1 ? 's were' : ' was'} already saved at the same date.
                </p>
              )}
              {skippedLabValues > 0 && (
                <p className="upload-done-skipped">
                  {skippedLabValues} additional lab value{skippedLabValues !== 1 ? 's were' : ' was'} already saved at the same date.
                </p>
              )}
              {refusalLines}
              {saveErrorCount > 0 && (
                <p className="upload-done-skipped">
                  {saveErrorCount} item{saveErrorCount !== 1 ? 's' : ''} could not be saved. Please try again.
                </p>
              )}
              <FileNotices notices={notices} />
              <NotSaved results={results} />
              <button className="btn-primary upload-done-btn" onClick={handleClose}>
                Done
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  ), document.body)}
  </>;
}
