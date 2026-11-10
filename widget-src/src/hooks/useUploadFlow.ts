import { useState, useRef, useCallback, useEffect } from 'react';
import { checkLabImportQuota } from '../lib/upload-api';
import { IMPORT_LIMITS } from '@roadmap/health-core/import-hints';
import { UNDATED_PREVIOUS, uploadLimitSignal, zipMemberName } from '@roadmap/health-core/lab-extraction';
import type { UnitSystem } from '@roadmap/health-core/units';
import { comparatorOf } from '@roadmap/health-core/lab-limits';
import type { DocumentPayload } from '@roadmap/health-core/document-save';
import type { LabUnitRefusal, MeasurementRefusal } from '@roadmap/health-core/record-edits';
import { UPLOAD_OUTCOME_KEYS, UPLOAD_OUTCOME_MAX, type UploadOutcomeKey } from '@roadmap/health-core/product-events';
import { bulkSaveMeasurements, bulkSaveDocuments, bulkSaveLabValues, getDocumentArchiveMode, getEraseIdentity, getShownErase } from '../lib/roadmap-data';
import { trackProductEvent } from '../lib/server-api';
import type { UploadErrorCode, UploadHistory } from '../lib/api-types';
import { UploadError, KEY_ERROR_MESSAGES, BATCH_THRESHOLD, MAX_FILE_SIZE, shortName, hasValues, processBatch, processPipeline, type FileNotice, type ReadInput, type DocumentToSave, type ReviewedValue, type ReviewedLabValue, type FileResult } from '../lib/upload-pipeline';
import { attachOriginals, synthesizeLabArchiveEntries, connectorDocumentEntries } from '../lib/archive-payloads';
import { createUploadBundleLoader } from '../lib/upload-bundle';
import { Sentry } from '../lib/sentry';
import { recordFailure } from '../lib/error-diagnostics';
import { SHOPIFY_SURFACE } from '../lib/build-flags';
import { isDocx } from '../lib/file-kinds';

/**
 * The upload flow, one named phase at a time (US-12).
 *
 * - picking: the dropzone. A pick with a file under the size limit starts a read.
 * - reading: the files are being read. Cancel returns to picking; a refusal
 *   or failure goes to readFailed; a finished read goes to reviewing.
 * - readFailed: the dropzone again, with the read's message. A new pick reads again.
 * - reviewing: the review table. Save goes to saving.
 * - saving: the save is writing. It ends in done, or in saveFailed.
 * - saveFailed: the review stays open, with the save's message. Save retries.
 * - done: everything saved.
 *
 * Discard returns any phase but saving to picking. Close does so only from
 * picking, readFailed and done; elsewhere it only hides the work.
 */
export type UploadPhase = 'picking' | 'reading' | 'readFailed' | 'reviewing' | 'saving' | 'saveFailed' | 'done';

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

export const MAX_FILES = IMPORT_LIMITS.websiteFiles; // also the server's per-IP daily limit (US-12 AC17)
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
  skippedValues: number; skippedLabValues: number; unstored: number;
  refusedLabUnits: LabUnitRefusal[]; refusedMeasurements: MeasurementRefusal[];
}
const NO_OUTCOME: SaveOutcome = { values: 0, labValues: 0, documents: [], skippedValues: 0, skippedLabValues: 0, unstored: 0, refusedLabUnits: [], refusedMeasurements: [] };
const NO_PROGRESS = { current: 0, total: 0, fileName: '' };

export interface UploadFlowOptions {
  unitSystem: UnitSystem;
  history: UploadHistory;
  /** The page's re-read; a partial save waits for it before a retry (US-12 AC6c). */
  onComplete: () => void | Promise<void>;
  onStart?: () => Promise<void>;
  onClose: () => void;
  /** `erase`: the erase the page showed as the save began (US-16 AC2a). */
  onScreeningUpdate?: (screeningKey: string, value: string, erase: string) => void;
}

export function useUploadFlow({ unitSystem, history, onComplete, onStart, onClose, onScreeningUpdate }: UploadFlowOptions) {
  const [phase, setPhase] = useState<UploadPhase>('picking');
  const [files, setFiles] = useState<File[]>([]);
  // Connect-first gate: skipped stays through a cancel; close and discard reset it (US-12 AC4).
  const [skipArchive, setSkipArchive] = useState(false);
  const [progress, setProgress] = useState(NO_PROGRESS);
  const [results, setResults] = useState<FileResult[]>([]);
  const [readError, setReadError] = useState<string | null>(null); // readFailed's message
  const [saveError, setSaveError] = useState<string | null>(null); // saveFailed's message
  const [notices, setNotices] = useState<FileNotice[]>([]);
  const [outcome, setOutcome] = useState(NO_OUTCOME);
  // The read's claim, taken synchronously: two picks in one render see it.
  const abortRef = useRef<AbortController | null>(null);
  // The save's claim, taken synchronously: a double Save, or Discard in the same render, sees it.
  const savingRef = useRef(false);
  useEffect(() => () => { abortRef.current?.abort(); }, []);
  const [loadUploadBundle] = useState(createUploadBundleLoader);

  const resetSession = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setPhase('picking');
    setFiles([]);
    setResults([]);
    setReadError(null);
    setSaveError(null);
    setNotices([]);
    setProgress(NO_PROGRESS);
    setOutcome(NO_OUTCOME);
  }, []);

  // Closing active work only hides it. Drafts and pending saves remain mounted.
  const close = useCallback(() => {
    if (!savingRef.current && (phase === 'picking' || phase === 'done' || phase === 'readFailed')) {
      resetSession();
      setSkipArchive(false);
    }
    onClose();
  }, [phase, onClose, resetSession]);

  const discard = useCallback(() => {
    if (savingRef.current) return;
    resetSession();
    setSkipArchive(false);
    onClose();
  }, [onClose, resetSession]);

  const read = async (filesToProcess: File[], tooLarge: FileNotice[], docx: number) => {
    // Claim synchronously: React state alone cannot guard two selections in
    // the same render, especially while quota/draft flushing is still pending.
    if (abortRef.current || savingRef.current || filesToProcess.length === 0) return;
    const abort = new AbortController();
    abortRef.current = abort;
    setPhase('reading');
    setReadError(null);
    setProgress({ current: 0, total: 100, fileName: 'Preparing upload...' });
    const updateProgress = (p: { current: number; total: number; fileName: string }) => {
      if (!abort.signal.aborted) setProgress(p);
    };
    const failRead = (message: string) => {
      setReadError(message);
      setPhase('readFailed');
      abortRef.current = null;
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
        failRead(quota.message ?? 'Daily upload limit reached. You can upload more tomorrow.');
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
          failRead('No readable files found.');
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
      setPhase('reviewing');
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
        failRead((err instanceof UploadError && ((!SHOPIFY_SURFACE && BYOK_ERROR_MESSAGES[err.code]) || UPLOAD_ERROR_MESSAGES[err.code]))
          || 'An error occurred while processing files. Please try again.');
      }
    }
  };

  /** Files from the picker or a drop. Only a file under the size limit starts a read. */
  const pick = (selectedFiles: FileList | null) => {
    if (!selectedFiles) return;
    const fileArray = Array.from(selectedFiles).slice(0, MAX_FILES);
    const valid = fileArray.filter(f => f.size <= MAX_FILE_SIZE);
    const tooLarge = fileArray.filter(f => f.size > MAX_FILE_SIZE).map(f => ({ name: f.name, reason: 'tooLarge' as const }));
    const docx = fileArray.filter(isDocx).length;
    setFiles(valid);
    setReadError(null);
    setNotices(tooLarge);
    if (valid.length > 0) void read(valid, tooLarge, docx);
    else if (tooLarge.length > 0) trackUploadOutcome(tooLarge.length, 0, docx, tooLarge);
  };

  const save = useCallback(async ({ values: selectedValues, documents, labValues, reviewed }: {
    values: ReviewedValue[];
    documents: DocumentToSave[];
    labValues: ReviewedLabValue[];
    reviewed: FileResult[];
  }) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setPhase('saving');
    setSaveError(null);
    // The last attempt's skips, errors and refusals belong to it: never beside a
    // new error. What it saved stays, and this attempt adds to it.
    const prior = { ...NO_OUTCOME, values: outcome.values, labValues: outcome.labValues, documents: outcome.documents };
    setOutcome(prior);
    const erase = getShownErase(); // the record this save was asked for
    const failSave = (message: string) => {
      setSaveError(message);
      setPhase('saveFailed');
    };
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
        unstored: savedDocs.unstored ?? 0,
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

      // A re-read that fails, at once or later, is only reported: what saved stays saved.
      const reportReread = (err: unknown) => { Sentry.captureException(recordFailure(err, 'Upload save failed'), { tags: { area: 'upload-save', branch: 'reread' } }); };
      const reread = () => { try { return Promise.resolve(onComplete()).catch(reportReread); } catch (err) { reportReread(err); return Promise.resolve(); } };
      if (!saveFailed) {
        trackProductEvent('upload_saved', { count: next.values + next.labValues + next.documents.length });
        setPhase('done');
        void reread();
      } else {
        // Stay in review: a second Save retries idempotently (values dedup on
        // skippedDuplicates, documents on contentHash). Save stays busy until the
        // page has read back what saved, so the retry does not send it again; a failed re-read is only reported.
        if (totalSaved > 0) await reread();
        failSave(threw ? 'Some items could not be saved. Please try again.' : 'Failed to save. Please try again.');
      }
    } catch {
      failSave('Failed to save. Please try again.');
    } finally {
      savingRef.current = false;
    }
  }, [onComplete, onScreeningUpdate, history.documents, outcome]);

  return {
    phase, files, notices, progress, results, outcome, readError, saveError,
    skipArchive, skipConnect: () => setSkipArchive(true),
    pick, cancel: resetSession, close, discard, save,
  };
}
