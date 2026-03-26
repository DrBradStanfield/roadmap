import { useState, useRef, useCallback, useEffect } from 'react';
import type { UnitSystem } from '@roadmap/health-core';
import { labImport, labImportBatch, pollBatchStatus, checkLabImportQuota, bulkSaveMeasurements, bulkSaveDocuments, type PageContent, type ExtractedValue, type ApiMeasurement } from '../lib/api';
import { ReviewTable, type FileResult, type DocumentToSave } from './ReviewTable';
import { useIsMobile } from '../lib/useIsMobile';
import { Sentry } from '../lib/sentry';

type ModalState = 'select' | 'processing' | 'review' | 'done';

interface UploadModalProps {
  unitSystem: UnitSystem;
  previousMeasurements: ApiMeasurement[];
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

/** Floating indicator shown when modal is hidden during processing */
export function FloatingUploadIndicator({ progress, onClick }: {
  progress: { current: number; total: number; fileName: string };
  onClick: () => void;
}) {
  const isDone = progress.current >= 100;
  return (
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
  );
}

const BATCH_THRESHOLD = 20; // Use batch API for 20+ files; pipeline for fewer
const POLL_INTERVAL = 5000;
const FAKE_TICK_INTERVAL = 500;
const EXTRACT_TIMEOUT = 30_000;

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

const MAX_FILES = 20;
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

export function UploadModal({ unitSystem, previousMeasurements, onComplete, onStart, onClose, onScreeningUpdate, birthYear, sex, hidden, onProcessingStart, onProcessingEnd, onProgressUpdate }: UploadModalProps) {
  const [state, setState] = useState<ModalState>('select');
  const [files, setFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState({ current: 0, total: 0, fileName: '' });
  const [results, setResults] = useState<FileResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [savedCount, setSavedCount] = useState(0);
  const [savedDocCount, setSavedDocCount] = useState(0);
  const [isSaving, setIsSaving] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isMobile = useIsMobile(768);

  // Dismiss modal — during processing/review, just hides (keeps state alive for floating indicator).
  // Only fully ends the upload flow from select or done states.
  const handleClose = useCallback(() => {
    if (state === 'select' || state === 'done') {
      onProcessingEnd?.(false);
    }
    onClose();
  }, [state, onClose, onProcessingEnd]);

  // Explicit discard — user clicked Cancel in review, intentionally discarding results
  const handleDiscard = useCallback(() => {
    onProcessingEnd?.(false);
    onClose();
  }, [onClose, onProcessingEnd]);

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

    try {
      const upload = await loadUploadBundle();

      // Build queue of files to process (ZIP entries + standalone files)
      const queue: Array<{ fileName: string; file: File }> = [];
      const zipFiles = files.filter(f => upload.isZip(f));
      const otherFiles = files.filter(f => !upload.isZip(f));

      for (const zip of zipFiles) {
        if (abort.signal.aborted) break;
        updateProgress({ current: 0, total: 100, fileName: `Opening ${zip.name}...` });
        const entries = await upload.getZipEntries(zip);
        for (const { name, entry } of entries) {
          if (abort.signal.aborted) break;
          const blob = await entry.async('blob');
          const fileObj = new File([blob], name.split('/').pop() || name);
          queue.push({ fileName: name, file: fileObj });
        }
      }
      for (const file of otherFiles) {
        queue.push({ fileName: file.name, file });
      }

      if (queue.length === 0 || abort.signal.aborted) {
        if (!abort.signal.aborted) {
          setError('No readable files found.');
          setState('select');
          onProcessingEnd?.(false);
        }
        return;
      }

      // Choose processing strategy based on file count
      const allResults: FileResult[] = queue.length >= BATCH_THRESHOLD
        ? await processBatch(upload, queue, abort, updateProgress)
        : await processPipeline(upload, queue, abort, updateProgress);

      setResults(allResults);
      setState('review');
    } catch (err) {
      if (!abort.signal.aborted) {
        console.error('Upload processing error:', err);
        Sentry.captureException(err);
        setError('An error occurred while processing files. Please try again.');
        setState('select');
        onProcessingEnd?.(false);
      }
    }
  };

  /** Pipeline: client extraction feeds queue, LLM calls drain it one at a time. */
  async function processPipeline(
    upload: HealthUploadAPI,
    queue: Array<{ fileName: string; file: File }>,
    abort: AbortController,
    updateProgress: (p: { current: number; total: number; fileName: string }) => void,
  ): Promise<FileResult[]> {
    const allResults: FileResult[] = [];
    const totalFiles = queue.length;
    let completedCount = 0;

    // Worker pool with LLM_CONCURRENCY=1 — sequential LLM calls, no 429 rate limits.
    // Client extraction runs ahead: by the time one LLM call finishes, the next file is already extracted.
    let activeWorkers = 0;
    let feedingDone = false;
    let resolveAll: (() => void) | null = null;
    const allDone = new Promise<void>(resolve => { resolveAll = resolve; });

    async function processOneFile(item: { fileName: string; file: File }): Promise<FileResult> {
      const { fileName, file } = item;
      try {
        let pages: PageContent[];
        if (upload.isPdf(file)) {
          pages = await Promise.race([
            upload.extractFromPdf(file),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), EXTRACT_TIMEOUT)),
          ]);
        } else if (upload.isImage(file)) {
          const base64 = await Promise.race([
            upload.resizeImage(file, 1200),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), EXTRACT_TIMEOUT)),
          ]);
          pages = [{ type: 'image', content: base64, mimeType: 'image/jpeg' }];
        } else {
          return { fileName, reportDate: null, values: [], unrecognized: [], error: 'Unsupported file type' };
        }

        const { result, error: importError } = await labImport(pages, unitSystem);
        if (result) {
          return {
            fileName,
            reportDate: result.reportDate,
            values: result.values,
            unrecognized: result.unrecognized,
            document: result.document ?? undefined,
          };
        }
        return { fileName, reportDate: null, values: [], unrecognized: [], error: importError || 'Extraction failed' };
      } catch (fileErr) {
        console.warn(`Failed to process ${fileName}:`, fileErr);
        return { fileName, reportDate: null, values: [], unrecognized: [], error: 'Failed to read this file' };
      }
    }

    function tryStartWorker() {
      // LLM_CONCURRENCY = 1: one LLM call at a time to avoid rate limits
      while (activeWorkers < 1 && queue.length > 0) {
        if (abort.signal.aborted) break;
        activeWorkers++;
        const item = queue.shift()!;
        const shortName = item.fileName.split('/').pop() || item.fileName;
        updateProgress({ current: Math.round((completedCount / totalFiles) * 100), total: 100, fileName: shortName });

        processOneFile(item).then(result => {
          allResults.push(result);
        }).catch(err => {
          console.warn('Unexpected worker error:', err);
          allResults.push({ fileName: item.fileName, reportDate: null, values: [], unrecognized: [], error: 'Processing failed' });
        }).finally(() => {
          completedCount++;
          activeWorkers--;
          updateProgress({
            current: Math.round((completedCount / totalFiles) * 100),
            total: 100,
            fileName: `Processed ${completedCount} of ${totalFiles}`,
          });
          tryStartWorker();
          if (feedingDone && activeWorkers === 0 && queue.length === 0) {
            resolveAll?.();
          }
        });
      }
    }

    // Start the worker immediately — queue already has all files from ZIP extraction
    feedingDone = true;
    tryStartWorker();

    if (queue.length === 0 && activeWorkers === 0) {
      resolveAll?.();
    }

    await allDone;
    return allResults;
  }

  /** Batch: send all files in one request, poll for results. For 20+ files. */
  async function processBatch(
    upload: HealthUploadAPI,
    queue: Array<{ fileName: string; file: File }>,
    abort: AbortController,
    updateProgress: (p: { current: number; total: number; fileName: string }) => void,
  ): Promise<FileResult[]> {
    // Extract pages from all files first
    const allFiles: Array<{ fileName: string; pages: PageContent[] }> = [];
    for (let i = 0; i < queue.length; i++) {
      if (abort.signal.aborted) break;
      const { fileName, file } = queue[i];
      const shortName = fileName.split('/').pop() || fileName;
      updateProgress({ current: Math.round((i / queue.length) * 30), total: 100, fileName: `Reading ${shortName}...` });
      try {
        let pages: PageContent[];
        if (upload.isPdf(file)) {
          pages = await Promise.race([
            upload.extractFromPdf(file),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), EXTRACT_TIMEOUT)),
          ]);
        } else if (upload.isImage(file)) {
          const base64 = await Promise.race([
            upload.resizeImage(file, 1200),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), EXTRACT_TIMEOUT)),
          ]);
          pages = [{ type: 'image', content: base64, mimeType: 'image/jpeg' }];
        } else continue;
        allFiles.push({ fileName, pages });
      } catch (err) {
        console.warn(`Failed to extract ${fileName}:`, err);
      }
    }

    if (allFiles.length === 0) throw new Error('No readable files found.');

    updateProgress({ current: 33, total: 100, fileName: `Analyzing ${allFiles.length} files...` });

    const { batchId, error: batchError } = await labImportBatch(allFiles);
    if (!batchId) throw new Error(batchError || 'Failed to start processing');

    // Poll with fake progress
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
        if (Date.now() > maxPollTime) throw new Error('Processing timed out. Please try again.');

        const poll = await pollBatchStatus(batchId);
        realCompleted = poll.completed;
        if (poll.error) throw new Error(poll.error);

        if (poll.status === 'ended' && poll.results) {
          clearInterval(fakeTimer);
          updateProgress({ current: 100, total: 100, fileName: 'All files processed!' });
          return poll.results.map(r => ({
            fileName: r.fileName || 'Unknown file',
            reportDate: r.reportDate,
            values: r.values || [],
            unrecognized: r.unrecognized || [],
            document: r.document ?? undefined,
          }));
        }
      }
      return []; // aborted
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

  const handleSave = useCallback(async (
    selectedValues: Array<{ metric: string; valueSI: number; recordedAt: string }>,
    documents: DocumentToSave[],
  ) => {
    setIsSaving(true);
    try {
      // Save lab values and documents in parallel
      const measurements = selectedValues.map(v => ({
        metricType: v.metric,
        value: v.valueSI,
        recordedAt: v.recordedAt,
        source: 'lab_import' as const,
      }));
      const docPayloads = documents.map(d => ({
        documentType: d.documentType,
        title: d.title,
        documentDate: d.documentDate,
        contentMd: d.contentMd,
        metadata: d.metadata,
        sourceFileName: d.sourceFileName,
      }));

      const [savedValues, savedDocs] = await Promise.all([
        measurements.length > 0 ? bulkSaveMeasurements(measurements) : Promise.resolve([]),
        docPayloads.length > 0 ? bulkSaveDocuments(docPayloads) : Promise.resolve([]),
      ]);

      setSavedCount(savedValues.length);
      setSavedDocCount(savedDocs.length);
      const totalSaved = savedValues.length + savedDocs.length;

      // Update screening dates for documents with screening mappings
      for (const doc of documents) {
        if (doc.screeningUpdate && onScreeningUpdate) {
          onScreeningUpdate(doc.screeningUpdate.key, doc.screeningUpdate.date);
        }
      }

      if (totalSaved > 0) {
        setState('done');
        onComplete();
      } else {
        setError('Failed to save. Please try again.');
      }
    } finally {
      setIsSaving(false);
    }
  }, [onComplete, onScreeningUpdate]);

  return (
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
              previousMeasurements={previousMeasurements}
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
                {savedCount > 0 && savedDocCount > 0 && ' and '}
                {savedDocCount > 0 && `${savedDocCount} document${savedDocCount !== 1 ? 's' : ''}`}
              </p>
              <button className="btn-primary upload-done-btn" onClick={handleClose}>
                Done
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
