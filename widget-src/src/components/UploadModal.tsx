import { useState, useRef, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { UnitSystem, MeasurementSource } from '@roadmap/health-core';
import { labImport, labImportBatch, pollBatchStatus, checkLabImportQuota, bulkSaveMeasurements, bulkSaveDocuments, bulkSaveLabValues, type PageContent, type UploadErrorCode, type UploadHistory } from '../lib/api';
import { ReviewTable, type FileResult, type DocumentToSave } from './ReviewTable';
import { useIsMobile } from '../lib/useIsMobile';
import { Sentry } from '../lib/sentry';

class UploadError extends Error {
  constructor(message: string, public code: UploadErrorCode) {
    super(message);
  }
}

const UPLOAD_ERROR_MESSAGES: Record<UploadErrorCode, string> = {
  rate_limit: 'Daily upload limit reached. You can upload more tomorrow.',
  timeout: 'Processing took too long. Try uploading fewer files at once.',
  server_restart: 'The server restarted during processing. Please try again.',
  no_files: 'No readable files found. Please check your files and try again.',
  server_error: 'Something went wrong on the server. Please try again.',
  network: 'Network error. Please check your connection and try again.',
};

type ModalState = 'select' | 'processing' | 'review' | 'done';

interface UploadModalProps {
  unitSystem: UnitSystem;
  history: UploadHistory;
  onComplete: () => void;
  onStart?: () => Promise<void>;
  onClose: () => void;
  onScreeningUpdate?: (screeningKey: string, value: string) => void;
  birthYear?: number;
  sex?: 'male' | 'female';
  /** When true, modal is hidden but stays mounted (processing continues in background) */
  hidden?: boolean;
  onProcessingStart?: () => void;
  onProcessingEnd?: (autoReopen: boolean) => void;
  onProgressUpdate?: (p: { current: number; total: number; fileName: string }) => void;
}

/** Floating indicator shown when modal is hidden during processing.
 *  Portaled to body for the same reason as the modal — position:fixed must
 *  resolve against the viewport, not the transform'd .health-tool ancestor. */
export function FloatingUploadIndicator({ progress, onClick }: {
  progress: { current: number; total: number; fileName: string };
  onClick: () => void;
}) {
  const isDone = progress.current >= 100;
  return createPortal((
    <div className="floating-upload-indicator" onClick={onClick} role="button" tabIndex={0}>
      <div className="floating-upload-text">
        {isDone ? 'Ready for review — click to open' : 'Processing health records...'}
      </div>
      {!isDone && (
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
// tokens each). Scan/letter markdown conversion (~4K tokens) can overflow,
// but server-side 429 retry in callAnthropic() absorbs occasional bursts.
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
  extractFromPdf: (file: File) => Promise<PageContent[]>;
  isPdf: (file: File) => boolean;
  getZipEntries: (file: File) => Promise<Array<{ name: string; entry: { async: (type: 'blob') => Promise<Blob> } }>>;
  isZip: (file: File) => boolean;
  resizeImage: (file: File, maxDim: number) => Promise<string>;
  isImage: (file: File) => boolean;
}

const MAX_FILES = 200;
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

export function UploadModal({ unitSystem, history, onComplete, onStart, onClose, onScreeningUpdate, birthYear, sex, hidden, onProcessingStart, onProcessingEnd, onProgressUpdate }: UploadModalProps) {
  const [state, setState] = useState<ModalState>('select');
  const [files, setFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState({ current: 0, total: 0, fileName: '' });
  const [results, setResults] = useState<FileResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [savedCount, setSavedCount] = useState(0);
  const [skippedMeasurements, setSkippedMeasurements] = useState(0);
  const [skippedLabValues, setSkippedLabValues] = useState(0);
  const [saveErrorCount, setSaveErrorCount] = useState(0);
  const [savedDocCount, setSavedDocCount] = useState(0);
  const [savedLabCount, setSavedLabCount] = useState(0);
  const [isSaving, setIsSaving] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isMobile = useIsMobile(768);

  // Reset post-save counters. Called whenever the modal fully closes (not when
  // it's just hidden during background processing), so the next reopen starts
  // from a clean slate rather than carrying the previous run's tally.
  const resetSaveCounters = useCallback(() => {
    setSavedCount(0);
    setSkippedMeasurements(0);
    setSkippedLabValues(0);
    setSaveErrorCount(0);
    setSavedDocCount(0);
    setSavedLabCount(0);
  }, []);

  // Dismiss modal — during processing/review, just hides (keeps state alive for floating indicator).
  // Only fully ends the upload flow from select or done states.
  const handleClose = useCallback(() => {
    if (state === 'select' || state === 'done') {
      onProcessingEnd?.(false);
      resetSaveCounters();
    }
    onClose();
  }, [state, onClose, onProcessingEnd, resetSaveCounters]);

  // Explicit discard — user clicked Cancel in review, intentionally discarding results
  const handleDiscard = useCallback(() => {
    onProcessingEnd?.(false);
    resetSaveCounters();
    onClose();
  }, [onClose, onProcessingEnd, resetSaveCounters]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape' && !hidden) handleClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [handleClose, hidden]);

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
    const valid = fileArray.filter(f => {
      if (f.size > MAX_FILE_SIZE) {
        setError(`${f.name} exceeds 10MB limit and was skipped`);
        return false;
      }
      return true;
    });
    setFiles(valid);
    if (valid.length > 0) setError(null);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    handleFileSelect(e.dataTransfer.files);
  };

  const handleProcess = async () => {
    if (files.length === 0) return;

    const quota = await checkLabImportQuota();
    if (!quota.allowed) {
      setError('Daily upload limit reached. You can upload more tomorrow.');
      return;
    }

    if (onStart) await onStart();

    setState('processing');
    onProcessingStart?.();
    setError(null);
    const abort = new AbortController();
    abortRef.current = abort;

    const updateProgress = (p: { current: number; total: number; fileName: string }) => {
      setProgress(p);
      onProgressUpdate?.(p);
    };

    // Collect file metadata for Sentry context on errors
    const fileNames = files.map(f => f.name);
    const fileTypes = files.map(f => f.type || 'unknown');
    const fileCount = files.length;

    try {
      const upload = await loadUploadBundle();
      const zipFiles = files.filter(f => upload.isZip(f));
      const otherFiles = files.filter(f => !upload.isZip(f));

      // Count total files for progress (need to peek inside ZIPs)
      let totalFiles = otherFiles.length;
      const zipEntryLists: Array<{ name: string; entry: { async: (type: 'blob') => Promise<Blob> } }[]> = [];
      for (const zip of zipFiles) {
        if (abort.signal.aborted) break;
        updateProgress({ current: 0, total: 100, fileName: `Opening ${zip.name}...` });
        const entries = await upload.getZipEntries(zip);
        zipEntryLists.push(entries);
        totalFiles += entries.length;
      }

      if (totalFiles === 0 || abort.signal.aborted) {
        if (!abort.signal.aborted) {
          setError('No readable files found.');
          setState('select');
          onProcessingEnd?.(false);
        }
        return;
      }

      // For batch path (>=20 files): extract all, then batch
      if (totalFiles >= BATCH_THRESHOLD) {
        const allFileObjects: Array<{ fileName: string; file: File }> = [];
        for (const entries of zipEntryLists) {
          for (const { name, entry } of entries) {
            const blob = await entry.async('blob');
            allFileObjects.push({ fileName: name, file: new File([blob], name.split('/').pop() || name) });
          }
        }
        for (const file of otherFiles) {
          allFileObjects.push({ fileName: file.name, file });
        }
        const allResults = await processBatch(upload, allFileObjects, abort, updateProgress);
        if (abort.signal.aborted) return;
        setResults(allResults);
        setState('review');
        return;
      }

      // Pipeline path (<20 files): producer extracts, consumer sends to LLM
      const allResults = await processPipeline(upload, zipEntryLists, otherFiles, totalFiles, abort, updateProgress, unitSystem);
      if (abort.signal.aborted) return;
      setResults(allResults);
      setState('review');
    } catch (err) {
      if (!abort.signal.aborted) {
        const code = err instanceof UploadError ? err.code : 'unknown';
        console.error('Upload processing error:', code, err);
        Sentry.captureException(err, {
          tags: { uploadErrorCode: code },
          extra: { fileNames, fileTypes, fileCount },
        });
        setError(err instanceof UploadError
          ? UPLOAD_ERROR_MESSAGES[err.code]
          : 'An error occurred while processing files. Please try again.');
        setState('select');
        onProcessingEnd?.(false);
      }
    }
  };

  /** Extract pages from a File (pdf.js or image resize) with timeout. */
  async function extractPages(upload: HealthUploadAPI, file: File): Promise<PageContent[]> {
    if (upload.isPdf(file)) {
      return Promise.race([
        upload.extractFromPdf(file),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), EXTRACT_TIMEOUT)),
      ]);
    } else if (upload.isImage(file)) {
      const base64 = await Promise.race([
        upload.resizeImage(file, 1200),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), EXTRACT_TIMEOUT)),
      ]);
      return [{ type: 'image', content: base64, mimeType: 'image/jpeg' }];
    }
    return [];
  }

  /**
   * Pipeline: producer extracts files (ZIP blob → pdf.js → pages), consumer
   * sends pages to LLM one at a time. Extraction runs ahead of LLM calls —
   * while file 1 is in the LLM (~5s), files 2-4 are being extracted client-side.
   */
  async function processPipeline(
    upload: HealthUploadAPI,
    zipEntryLists: Array<Array<{ name: string; entry: { async: (type: 'blob') => Promise<Blob> } }>>,
    otherFiles: File[],
    totalFiles: number,
    abort: AbortController,
    updateProgress: (p: { current: number; total: number; fileName: string }) => void,
    us: UnitSystem,
  ): Promise<FileResult[]> {
    const queue: Array<{ fileName: string; pages: PageContent[] }> = [];
    const allResults: FileResult[] = [];
    let completedCount = 0;
    let activeWorkers = 0;
    let feedingDone = false;
    let resolveAll: (() => void) | null = null;
    const allDone = new Promise<void>(resolve => { resolveAll = resolve; });

    function checkDone() {
      if (feedingDone && activeWorkers === 0 && queue.length === 0) {
        resolveAll?.();
      }
    }

    function tryStartWorker() {
      while (activeWorkers < LLM_CONCURRENCY && queue.length > 0) {
        if (abort.signal.aborted) break;
        activeWorkers++;
        const item = queue.shift()!;
        const shortName = item.fileName.split('/').pop() || item.fileName;
        updateProgress({ current: Math.round((completedCount / totalFiles) * 100), total: 100, fileName: shortName });

        // Send to LLM
        labImport(item.pages, us).then(({ result, error: importError }) => {
          if (result) {
            allResults.push({
              fileName: item.fileName,
              reportDate: result.reportDate,
              values: result.values,
              additionalValues: result.additionalValues || [],
              document: result.document ?? undefined,
            });
          } else {
            allResults.push({ fileName: item.fileName, reportDate: null, values: [], additionalValues: [], error: importError || 'Extraction failed' });
          }
        }).catch(() => {
          allResults.push({ fileName: item.fileName, reportDate: null, values: [], additionalValues: [], error: 'Processing failed' });
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

    // Producer: collect all inputs, then run a pool of extractors in parallel.
    // Sequential extraction starved LLM workers (extraction ~2s vs LLM ~5s);
    // EXTRACT_CONCURRENCY parallel extractors keep the LLM queue full.
    const allInputs: Array<{ fileName: string; getFile: () => Promise<File> }> = [];
    for (const entries of zipEntryLists) {
      for (const { name, entry } of entries) {
        allInputs.push({
          fileName: name,
          getFile: async () => {
            const blob = await entry.async('blob');
            return new File([blob], name.split('/').pop() || name);
          },
        });
      }
    }
    for (const file of otherFiles) {
      allInputs.push({ fileName: file.name, getFile: async () => file });
    }

    let extractIndex = 0;
    async function extractWorker() {
      while (extractIndex < allInputs.length) {
        if (abort.signal.aborted) break;
        const i = extractIndex++;
        const { fileName, getFile } = allInputs[i];
        try {
          const file = await getFile();
          const pages = await extractPages(upload, file);
          if (pages.length > 0) {
            queue.push({ fileName, pages });
            tryStartWorker();
          }
        } catch (err) {
          console.warn(`Failed to extract ${fileName}:`, err);
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
    queue: Array<{ fileName: string; file: File }>,
    abort: AbortController,
    updateProgress: (p: { current: number; total: number; fileName: string }) => void,
  ): Promise<FileResult[]> {
    const allFiles: Array<{ fileName: string; pages: PageContent[] }> = [];
    for (let i = 0; i < queue.length; i++) {
      if (abort.signal.aborted) break;
      const { fileName, file } = queue[i];
      const shortName = fileName.split('/').pop() || fileName;
      updateProgress({ current: Math.round((i / queue.length) * 30), total: 100, fileName: `Reading ${shortName}...` });
      try {
        const pages = await extractPages(upload, file);
        if (pages.length > 0) allFiles.push({ fileName, pages });
      } catch (err) {
        console.warn(`Failed to extract ${fileName}:`, err);
      }
    }

    if (allFiles.length === 0) throw new UploadError('No readable files found.', 'no_files');

    updateProgress({ current: 33, total: 100, fileName: `Analyzing ${allFiles.length} files...` });

    const { batchId, error: batchError, errorCode: batchErrorCode } = await labImportBatch(allFiles);
    if (!batchId) throw new UploadError(batchError || 'Failed to start processing', batchErrorCode || 'server_error');

    const fileNames = allFiles.map(f => (f.fileName.split('/').pop() || f.fileName));
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
          return poll.results.map(r => ({
            fileName: r.fileName || 'Unknown file',
            reportDate: r.reportDate,
            values: r.values || [],
            additionalValues: r.additionalValues || [],
            document: r.document ?? undefined,
          }));
        }
      }
      return [];
    } finally {
      clearInterval(fakeTimer);
    }
  }

  const handleCancel = () => {
    abortRef.current?.abort();
    setError(null);
    onProcessingEnd?.(false);
    if (results.length > 0) {
      setState('review');
    } else {
      setState('select');
    }
  };

  const handleSave = useCallback(async ({ values: selectedValues, documents, labValues }: {
    values: Array<{ metric: string; valueSI: number; recordedAt: string; source?: MeasurementSource }>;
    documents: DocumentToSave[];
    labValues: Array<{ name: string; value: number; unit: string; referenceLow?: number | null; referenceHigh?: number | null; recordedAt: string }>;
  }) => {
    setIsSaving(true);
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
      }));
      const docPayloads = documents.map(d => ({
        documentType: d.documentType,
        title: d.title,
        documentDate: d.documentDate,
        contentMd: d.contentMd,
        metadata: d.metadata,
        sourceFileName: d.sourceFileName,
      }));
      const labValuePayloads = labValues.map(lv => ({
        metricName: lv.name,
        value: lv.value,
        unit: lv.unit,
        referenceLow: lv.referenceLow,
        referenceHigh: lv.referenceHigh,
        recordedAt: lv.recordedAt,
        source: 'lab_import' as const,
      }));

      const [savedValues, savedDocs, savedLabValues] = await Promise.all([
        measurements.length > 0 ? bulkSaveMeasurements(measurements) : Promise.resolve({ saved: [], skippedDuplicates: 0, errorCount: 0 }),
        docPayloads.length > 0 ? bulkSaveDocuments(docPayloads) : Promise.resolve([]),
        labValuePayloads.length > 0 ? bulkSaveLabValues(labValuePayloads) : Promise.resolve({ saved: [], skippedDuplicates: 0, errorCount: 0 }),
      ]);

      setSavedCount(savedValues.saved.length);
      setSkippedMeasurements(savedValues.skippedDuplicates);
      setSkippedLabValues(savedLabValues.skippedDuplicates);
      setSaveErrorCount(savedValues.errorCount + savedLabValues.errorCount);
      setSavedDocCount(savedDocs.length);
      setSavedLabCount(savedLabValues.saved.length);
      // 100% duplicates is still "ok" — DB already has the data. Only fail
      // if everything errored AND nothing was a known-duplicate.
      const totalSaved = savedValues.saved.length + savedDocs.length + savedLabValues.saved.length;
      const totalCompleted = totalSaved + savedValues.skippedDuplicates + savedLabValues.skippedDuplicates;

      // Update screening dates for documents with screening mappings
      for (const doc of documents) {
        if (doc.screeningUpdate && onScreeningUpdate) {
          onScreeningUpdate(doc.screeningUpdate.key, doc.screeningUpdate.date);
        }
      }

      if (totalCompleted > 0) {
        setState('done');
        onComplete();
      } else {
        setError('Failed to save. Please try again.');
      }
    } finally {
      setIsSaving(false);
    }
  }, [onComplete, onScreeningUpdate]);

  // Portal to body so position:fixed resolves against the viewport — the
  // .health-tool container has a transform/contain that would otherwise pin
  // the modal inside the (very tall) widget root instead of the viewport.
  return createPortal((
    <div className="upload-modal-backdrop" style={hidden ? { display: 'none' } : undefined} onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}>
      <div className={`upload-modal${isMobile ? ' upload-modal--mobile' : ''}`}>
        <div className="upload-modal-header">
          <h3>Upload Health Records</h3>
          <button className="upload-modal-close" onClick={handleClose} aria-label="Close">&times;</button>
        </div>

        <div className="upload-modal-body">
          {state === 'select' && (
            <div className="upload-select">
              <div
                className="upload-dropzone"
                onDrop={handleDrop}
                onDragOver={(e) => e.preventDefault()}
                onClick={() => fileInputRef.current?.click()}
              >
                <div className="upload-dropzone-icon">&#128196;</div>
                <p className="upload-dropzone-text">Drop health records here, or click to browse</p>
                <p className="upload-dropzone-hint">PDF, JPG, PNG, or ZIP &mdash; up to {MAX_FILES} files</p>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.jpg,.jpeg,.png,.zip"
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
              {files.length > 0 && (
                <button className="btn-primary upload-extract-btn" onClick={handleProcess}>
                  Process Files
                </button>
              )}
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

          {state === 'review' && (
            <ReviewTable
              results={results}
              history={history}
              unitSystem={unitSystem}
              birthYear={birthYear}
              sex={sex}
              onSave={handleSave}
              onCancel={handleDiscard}
              isSaving={isSaving}
              error={error}
            />
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
                  && skippedMeasurements === 0 && skippedLabValues === 0 && saveErrorCount === 0 && 'No items saved'}
              </p>
              {skippedMeasurements > 0 && (
                <p className="upload-done-skipped">
                  {skippedMeasurements} blood test value{skippedMeasurements !== 1 ? 's were' : ' was'} already saved at the same date. Close this dialog and click the existing value in the Blood Test Results table to correct it.
                </p>
              )}
              {skippedLabValues > 0 && (
                <p className="upload-done-skipped">
                  {skippedLabValues} additional lab value{skippedLabValues !== 1 ? 's were' : ' was'} already saved at the same date.
                </p>
              )}
              {saveErrorCount > 0 && (
                <p className="upload-done-skipped">
                  {saveErrorCount} value{saveErrorCount !== 1 ? 's' : ''} could not be saved due to a server error. Please try again.
                </p>
              )}
              <button className="btn-primary upload-done-btn" onClick={handleClose}>
                Done
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  ), document.body);
}
