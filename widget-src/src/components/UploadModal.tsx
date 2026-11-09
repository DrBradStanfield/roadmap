import { checkLabImportQuota } from '../lib/upload-api';
import { useState, useRef, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { IMPORT_LIMITS } from '@roadmap/health-core/import-hints';
import { UNDATED_PREVIOUS, uploadLimitSignal, zipMemberName } from '@roadmap/health-core/lab-extraction';
import type { UnitSystem, MetricType } from '@roadmap/health-core/units';
import { comparatorOf } from '@roadmap/health-core/lab-limits';
import type { DocumentPayload } from '@roadmap/health-core/document-save';
import type { LabUnitRefusal, MeasurementRefusal } from '@roadmap/health-core/record-edits';
import { UPLOAD_OUTCOME_KEYS, UPLOAD_OUTCOME_MAX, type UploadOutcomeKey } from '@roadmap/health-core/product-events';
import { bulkSaveMeasurements, bulkSaveDocuments, bulkSaveLabValues, getDocumentArchiveMode, getEraseIdentity, getShownErase } from '../lib/roadmap-data';
import { trackProductEvent } from '../lib/server-api';
import type { UploadErrorCode, UploadHistory } from '../lib/api-types';
import { measurementRefusalLine } from '../lib/lab-value-labels';
import { labUnitRefusalLine } from '@roadmap/health-core/lab-series';
import { useLpaUnit } from '../lib/lpa-unit';
import type { Grading } from '../lib/blood-test-cell';
import { ReviewTable } from './ReviewTable';
import { FileNotices, NotSaved } from './UploadNotices';
import { ErrorBoundary } from './ErrorBoundary';
import { FloatingUploadIndicator } from './FloatingUploadIndicator';
import { UploadError, KEY_ERROR_MESSAGES, BATCH_THRESHOLD, MAX_FILE_SIZE, shortName, hasValues, processBatch, processPipeline, type FileNotice, type ReadInput, type DocumentToSave, type ReviewedValue, type ReviewedLabValue, type FileResult } from '../lib/upload-pipeline';
import { attachOriginals, synthesizeLabArchiveEntries, connectorDocumentEntries } from '../lib/archive-payloads';
import { useIsMobile } from '../lib/useIsMobile';
import { Sentry } from '../lib/sentry';
import { recordFailure } from '../lib/error-diagnostics';
import { openBackendPicker, UPLOAD_STORAGE_NOTICE } from '../lib/storage-notice';
import { SHOPIFY_SURFACE } from '../lib/build-flags';
import { isDocx } from '../lib/file-kinds';
import type { HealthUploadAPI } from '../upload-entry';

/** Upload-level failures only: `refused` and `too_long` are one file's notice (UploadNotices.tsx). */
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

export type ModalState = 'select' | 'processing' | 'review' | 'done' | 'error';

interface UploadModalProps {
  unitSystem: UnitSystem;
  metricUnitOverrides?: Partial<Record<MetricType, UnitSystem>>;
  onToggleFieldUnit?: (field: string) => void;
  history: UploadHistory;
  /** The page's re-read; a partial save waits for it before a retry (US-12 AC6c). */
  onComplete: () => void | Promise<void>;
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

const MAX_FILES = IMPORT_LIMITS.websiteFiles; // also the server's per-IP daily limit (US-12 AC17)
const EMPTY_ZIP_TEXT = 'No files we can read inside this ZIP.';
const OVER_LIMIT_TEXT = `Not read. It is over the ${MAX_FILES}-file limit for one upload. Upload it separately.`;

/** US-12 AC10: one run's counts, integers only. Never a name, unit or value.
 *  `docx` is how many of the picked files were .docx (AC13); `values` holds
 *  value counts: `undatedPrevious` from an undated previous column (AC14),
 *  `unitsGuessed` (AC16), `unitsRefused` (AC15), and the read files' limits
 *  (`uploadLimitSignal`, AC20): `valuesLimit`, `valuesLimitUngraded`, and the
 *  closed-list keys of the ungraded tests, the one non-count. A zero, or an
 *  empty list, is never sent: every key is optional, so a server a deploy
 *  behind meets a new key only once it counts something. */
function trackUploadOutcome(picked: number, withValues: number, docx: number, notices: FileNotice[], values: Partial<Record<'undatedPrevious' | 'unitsGuessed' | 'unitsRefused' | 'valuesLimit' | 'valuesLimitUngraded', number>> = {}, limitUngradedTests: string[] = []): void {
  const counts: Partial<Record<UploadOutcomeKey, number>> = { picked, withValues, docx, ...values };
  for (const n of notices) counts[n.reason] = (counts[n.reason] ?? 0) + (n.count ?? 1);
  trackProductEvent('upload_outcome', {
    ...Object.fromEntries(UPLOAD_OUTCOME_KEYS.filter(k => counts[k]).map(k => [k, Math.min(counts[k]!, UPLOAD_OUTCOME_MAX)])),
    ...(limitUngradedTests.length ? { limitUngradedTests } : null),
  });
}

/** One session's save outcome (US-12 AC6c). The saved counts add up across a
 *  retry, which finishes what the first Save began; the rest are the last
 *  attempt's. Documents count by content, else name: a retry may refile one. `unstored`: originals the cloud would not store behind details it
 *  already holds (US-14 AC4). The refusals are lab rows in a unit the record
 *  does not know for that test, and core values it refused: each is named, as
 *  a dropped value must never be silent (US-21 phase 3, US-35 AC17). */
interface SaveOutcome {
  values: number; labValues: number; documents: string[];
  skippedValues: number; skippedLabValues: number; errors: number; unstored: number;
  refusedLabUnits: LabUnitRefusal[]; refusedMeasurements: MeasurementRefusal[];
}
const NO_OUTCOME: SaveOutcome = { values: 0, labValues: 0, documents: [], skippedValues: 0, skippedLabValues: 0, errors: 0, unstored: 0, refusedLabUnits: [], refusedMeasurements: [] };

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
  const [outcome, setOutcome] = useState(NO_OUTCOME);
  const { values: savedCount, labValues: savedLabCount, documents: { length: savedDocCount }, skippedValues: skippedMeasurements, skippedLabValues, errors: saveErrorCount, unstored: unstoredCount, refusedLabUnits, refusedMeasurements } = outcome;
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
    setOutcome(NO_OUTCOME);
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
    if (window.HealthUpload) return Promise.resolve(window.HealthUpload);
    if (loadPromiseRef.current) return loadPromiseRef.current;

    const root = document.getElementById('health-tool-root');
    const src = root?.dataset.uploadUrl;
    if (!src) return Promise.reject(new Error('Upload bundle URL not found'));

    loadPromiseRef.current = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.onload = () => {
        const upload = window.HealthUpload;
        if (upload) {
          resolve(upload);
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
      const { limitUngradedTests, ...limits } = uploadLimitSignal(finished.filter(r => !r.error));
      setNotices(runNotices);
      trackUploadOutcome(tooLarge.length + names.length, withValues, docx, runNotices, { ...values, ...limits }, limitUngradedTests);
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
    // The last attempt's skips, errors and refusals belong to it: never beside a
    // new error. What it saved stays, and this attempt adds to it.
    const prior = { ...NO_OUTCOME, values: outcome.values, labValues: outcome.labValues, documents: outcome.documents };
    setOutcome(prior);
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
        ...comparatorOf(v),
      }));
      // Blobs travel INSIDE the payload (attached at processing time, and only
      // when the backend can archive them) — no name-keyed re-join here.
      const docPayloads: DocumentPayload<Blob>[] = documents.map(d => ({
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
        ...comparatorOf(lv),
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
        docPayloads.length > 0 ? bulkSaveDocuments(docPayloads).catch(failed('documents', { saved: [], errorCount: docPayloads.length, unstored: 0 })) : Promise.resolve({ saved: [], errorCount: 0, unstored: 0 }),
        labValuePayloads.length > 0 ? bulkSaveLabValues(labValuePayloads).catch(failed('labValues', { saved: [], skippedDuplicates: 0, errorCount: labValuePayloads.length, refused: [] })) : Promise.resolve({ saved: [], skippedDuplicates: 0, errorCount: 0, refused: [] }),
      ]);

      const saveErrors = savedValues.errorCount + savedLabValues.errorCount + savedDocs.errorCount;
      const next: SaveOutcome = {
        values: prior.values + savedValues.saved.length,
        labValues: prior.labValues + savedLabValues.saved.length,
        documents: [...new Set([...prior.documents, ...savedDocs.saved.map(d => d.contentHash ?? d.sourceFileName ?? d.id)])],
        skippedValues: savedValues.skippedDuplicates, skippedLabValues: savedLabValues.skippedDuplicates,
        errors: saveErrors, unstored: savedDocs.unstored ?? 0,
        refusedLabUnits: savedLabValues.refused, refusedMeasurements: savedValues.refused,
      };
      setOutcome(next);
      // A save error keeps the review open for retry (US-12 AC6). Skipped
      // values and refusals are settled outcomes, reported on the done screen;
      // a skip does not establish that the reviewed value is already saved.
      const totalSaved = savedValues.saved.length + savedDocs.saved.length + savedLabValues.saved.length;
      const saveFailed = threw || saveErrors > 0;

      // Update screening dates for documents with screening mappings, unless
      // the record was erased while the save ran: the date belongs to it.
      for (const doc of getEraseIdentity() === erase ? documents : []) {
        if (doc.screeningUpdate && onScreeningUpdate) {
          onScreeningUpdate(doc.screeningUpdate.key, doc.screeningUpdate.date, erase);
        }
      }

      const reread = () => Promise.resolve(onComplete()).catch(err => { Sentry.captureException(recordFailure(err, 'Upload save failed'), { tags: { area: 'upload-save', branch: 'reread' } }); });
      if (!saveFailed) {
        trackProductEvent('upload_saved', { count: next.values + next.labValues + next.documents.length });
        setState('done');
        void reread();
      } else {
        // Stay in review: a second Save retries idempotently (values dedup on
        // skippedDuplicates, documents on contentHash). Save stays busy until the
        // page has read back what saved, so the retry does not send it again; a failed re-read is only reported.
        if (totalSaved > 0) await reread();
        setError(threw ? 'Some items could not be saved. Please try again.' : 'Failed to save. Please try again.');
      }
    } catch {
      setError('Failed to save. Please try again.');
    } finally {
      savingRef.current = false;
      setIsSaving(false);
    }
  }, [onComplete, onScreeningUpdate, history.documents, outcome]);

  // One report can refuse the same test on several dates; the user needs it
  // named once. A note says what to look for instead, where there is one, and
  // a unit the test takes was refused for its number, not its unit (US-21
  // AC15). Shown on the done screen and, beside the retry message, in review
  // (US-12 AC6): a refusal is settled the moment the save answers.
  const refusalLines = <>
    {[...new Map(refusedLabUnits.map(r => [`${r.key}|${r.unit}|${r.bound ?? ''}`, r])).values()].map(r => (
      <p key={`${r.key}|${r.unit}|${r.bound ?? ''}`} className="upload-done-skipped">{labUnitRefusalLine(r.key, r.unit, r.fault, r.bound)}</p>
    ))}
    {[...new Set(refusedMeasurements.map(r => measurementRefusalLine(r, r.metricType === 'lpa' ? lpaUnit : metricUnitOverrides?.[r.metricType as MetricType] ?? unitSystem)))].map(line => (
      <p key={line} className="upload-done-skipped">{line}</p>
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
                  && unstoredCount === 0 && refusedLabUnits.length === 0 && refusedMeasurements.length === 0 && 'No items saved'}
              </p>
              {skippedMeasurements > 0 && (
                <p className="upload-done-skipped">
                  {skippedMeasurements} blood test value{skippedMeasurements !== 1 ? 's were' : ' was'} not added. Check your blood test table: a value was already recorded for that date, or changed during review.
                </p>
              )}
              {skippedLabValues > 0 && (
                <p className="upload-done-skipped">
                  {skippedLabValues} additional lab value{skippedLabValues !== 1 ? 's were' : ' was'} not added. Check your blood test table: a value was already recorded for that date, or changed during review.
                </p>
              )}
              {refusalLines}
              {unstoredCount > 0 && <p className="upload-done-skipped">The original file couldn't be stored; its details are saved.</p>}
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
