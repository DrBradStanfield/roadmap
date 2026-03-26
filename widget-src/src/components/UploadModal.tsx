import { useState, useRef, useCallback, useEffect } from 'react';
import type { UnitSystem } from '@roadmap/health-core';
import { labImportBatch, pollBatchStatus, checkLabImportQuota, bulkSaveMeasurements, bulkSaveDocuments, type PageContent, type ExtractedValue, type ApiMeasurement } from '../lib/api';
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

const POLL_INTERVAL = 5000;
const FAKE_TICK_INTERVAL = 500;

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

    // Preflight: check quota before any processing to avoid wasted work
    const quota = await checkLabImportQuota();
    if (!quota.allowed) {
      setError('Daily upload limit reached. You can upload more tomorrow.');
      return;
    }

    // Save any unsaved form values (weight, BP, etc.) before processing
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

      // --- Phase 1: Extract pages from all files (client-side) ---
      // Count total extractable files first for progress
      const zipFiles = files.filter(f => upload.isZip(f));
      const otherFiles = files.filter(f => !upload.isZip(f));
      const allFiles: Array<{ fileName: string; pages: PageContent[] }> = [];
      let extractedCount = 0;

      // Gather all file entries to know the total
      const fileEntries: Array<{ name: string; extract: () => Promise<PageContent[]> }> = [];

      for (const zip of zipFiles) {
        if (abort.signal.aborted) break;
        updateProgress({ current: 0, total: 100, fileName: `Opening ${zip.name}...` });
        const entries = await upload.getZipEntries(zip);
        for (const { name, entry } of entries) {
          fileEntries.push({
            name,
            extract: async () => {
              const blob = await entry.async('blob');
              const fileObj = new File([blob], name.split('/').pop() || name);
              if (upload.isPdf(fileObj)) {
                return Promise.race([
                  upload.extractFromPdf(fileObj),
                  new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 30_000)),
                ]);
              } else if (upload.isImage(fileObj)) {
                const base64 = await Promise.race([
                  upload.resizeImage(fileObj, 1200),
                  new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 30_000)),
                ]);
                return [{ type: 'image' as const, content: base64, mimeType: 'image/jpeg' }];
              }
              return [];
            },
          });
        }
      }

      for (const file of otherFiles) {
        fileEntries.push({
          name: file.name,
          extract: async () => {
            if (upload.isPdf(file)) {
              return Promise.race([
                upload.extractFromPdf(file),
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 30_000)),
              ]);
            } else if (upload.isImage(file)) {
              const base64 = await Promise.race([
                upload.resizeImage(file, 1200),
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 30_000)),
              ]);
              return [{ type: 'image' as const, content: base64, mimeType: 'image/jpeg' }];
            }
            return [];
          },
        });
      }

      const totalToExtract = fileEntries.length;

      for (const entry of fileEntries) {
        if (abort.signal.aborted) break;
        const shortName = entry.name.split('/').pop() || entry.name;
        // Show extraction progress as 0-30% of total (Phase 1 gets first 30%)
        const extractPct = Math.round((extractedCount / totalToExtract) * 30);
        updateProgress({ current: extractPct, total: 100, fileName: `Reading ${shortName}...` });
        try {
          const pages = await entry.extract();
          if (pages.length > 0) allFiles.push({ fileName: entry.name, pages });
        } catch (err) {
          console.warn(`Failed to extract ${entry.name}:`, err);
        }
        extractedCount++;
      }

      // Show extraction complete
      updateProgress({ current: 30, total: 100, fileName: `Extracted ${allFiles.length} files` });

      if (allFiles.length === 0 || abort.signal.aborted) {
        if (!abort.signal.aborted) {
          setError('No readable files found.');
          setState('select');
          onProcessingEnd?.(false);
        }
        return;
      }

      // --- Phase 2: Send all files to Batch API ---
      updateProgress({ current: 33, total: 100, fileName: `Analyzing ${allFiles.length} files...` });

      const { batchId, error: batchError } = await labImportBatch(allFiles);
      if (!batchId) {
        setError(batchError || 'Failed to start processing');
        setState('select');
        onProcessingEnd?.(false);
        return;
      }

      // --- Phase 3: Poll with fake progress ---
      const fileNames = allFiles.map(f => (f.fileName.split('/').pop() || f.fileName));
      let fakeProgress = 35; // Start at 35% — extraction (0-30%) + sending (33%) done
      let realCompleted = 0;
      let tickCount = 0;

      // Fake progress timer — asymptotic curve, never exceeds 90%
      // Cycles through status messages + filenames for a lively feel
      const fakeTimer = setInterval(() => {
        if (abort.signal.aborted) return;
        tickCount++;
        fakeProgress += (90 - fakeProgress) * 0.015;
        const realPct = allFiles.length > 0 ? (realCompleted / allFiles.length) * 100 : 0;
        const displayPct = Math.max(fakeProgress, realPct);
        // Alternate: status message (every ~8 ticks / 4s) then filename
        const statusMsg = PROGRESS_MESSAGES[Math.floor(tickCount / 8) % PROGRESS_MESSAGES.length];
        const fileName = fileNames[Math.floor(tickCount / 3) % fileNames.length];
        const msg = realCompleted > 0
          ? `Processed ${realCompleted} of ${allFiles.length} — ${fileName}`
          : `${statusMsg} ${fileName}`;
        updateProgress({ current: Math.round(displayPct), total: 100, fileName: msg });
      }, FAKE_TICK_INTERVAL);

      try {
        // Poll until batch completes (max 10 minutes to avoid infinite poll after server restart)
        const maxPollTime = Date.now() + 10 * 60_000;
        while (!abort.signal.aborted) {
          await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
          if (abort.signal.aborted) break;

          if (Date.now() > maxPollTime) {
            throw new Error('Processing timed out. Please try again.');
          }

          const poll = await pollBatchStatus(batchId);
          realCompleted = poll.completed;

          // Terminal error (e.g., batch not found after server restart)
          if (poll.error) {
            throw new Error(poll.error);
          }

          if (poll.status === 'ended' && poll.results) {
            clearInterval(fakeTimer);


            // Map results to FileResult format
            const allResults: FileResult[] = poll.results.map(r => ({
              fileName: r.fileName || 'Unknown file',
              reportDate: r.reportDate,
              values: r.values || [],
              unrecognized: r.unrecognized || [],
              document: r.document ?? undefined,
            }));

            updateProgress({ current: 100, total: 100, fileName: 'All files processed!' });
            setResults(allResults);
            setState('review');
            return;
          }
        }
      } finally {
        clearInterval(fakeTimer);
      }
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
