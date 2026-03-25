import { useState, useRef, useCallback, useEffect } from 'react';
import type { UnitSystem } from '@roadmap/health-core';
import { labImport, bulkSaveMeasurements, type PageContent, type ExtractedValue, type ApiMeasurement } from '../lib/api';
import { ReviewTable, type FileResult } from './ReviewTable';
import { useIsMobile } from '../lib/useIsMobile';

type ModalState = 'select' | 'processing' | 'review' | 'done';

interface UploadModalProps {
  unitSystem: UnitSystem;
  previousMeasurements: ApiMeasurement[];
  onComplete: () => void;
  onStart?: () => Promise<void>;
  onClose: () => void;
}

// Types for the upload processing bundle (loaded lazily)
interface HealthUploadAPI {
  extractFromPdf: (file: File) => Promise<PageContent[]>;
  isPdf: (file: File) => boolean;
  processZip: (
    file: File,
    onProgress?: (p: { current: number; total: number; fileName: string }) => void,
    abortSignal?: AbortSignal,
  ) => Promise<Array<{ fileName: string; pages: PageContent[] }>>;
  isZip: (file: File) => boolean;
  resizeImage: (file: File, maxDim: number) => Promise<string>;
  isImage: (file: File) => boolean;
}

const MAX_FILES = 20;
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

export function UploadModal({ unitSystem, previousMeasurements, onComplete, onStart, onClose }: UploadModalProps) {
  const [state, setState] = useState<ModalState>('select');
  const [files, setFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState({ current: 0, total: 0, fileName: '' });
  const [results, setResults] = useState<FileResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [savedCount, setSavedCount] = useState(0);
  const [isSaving, setIsSaving] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isMobile = useIsMobile(768);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

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

    // Save any unsaved form values (weight, BP, etc.) before processing
    if (onStart) await onStart();

    setState('processing');
    setError(null);
    const abort = new AbortController();
    abortRef.current = abort;

    try {
      const upload = await loadUploadBundle();
      const allResults: FileResult[] = [];

      const zipFiles = files.filter(f => upload.isZip(f));
      const otherFiles = files.filter(f => !upload.isZip(f));

      // Phase 1: Extract ZIPs to get actual file list
      const allFilesToProcess: Array<{ fileName: string; pages: PageContent[] } | { file: File }> = [];

      for (const zip of zipFiles) {
        if (abort.signal.aborted) break;
        setProgress({ current: 0, total: 0, fileName: `Extracting ${zip.name}...` });

        const extracted = await upload.processZip(zip, (p) => {
          setProgress({ current: p.current, total: p.total, fileName: `Extracting ${zip.name}: ${p.fileName}` });
        }, abort.signal);

        for (const ef of extracted) {
          allFilesToProcess.push(ef);
        }
      }
      for (const file of otherFiles) {
        allFilesToProcess.push({ file });
      }

      // Phase 2: Process each file through LLM with accurate progress
      let processedCount = 0;
      const totalFiles = allFilesToProcess.length;

      for (const item of allFilesToProcess) {
        if (abort.signal.aborted) break;

        let pages: PageContent[];
        let fileName: string;

        if ('pages' in item) {
          // Already extracted from ZIP
          pages = item.pages;
          fileName = item.fileName;
        } else {
          // Individual file — extract now
          const file = item.file;
          fileName = file.name;
          if (upload.isPdf(file)) {
            pages = await upload.extractFromPdf(file);
          } else if (upload.isImage(file)) {
            const base64 = await upload.resizeImage(file, 1500);
            pages = [{ type: 'image', content: base64, mimeType: 'image/jpeg' }];
          } else {
            continue;
          }
        }

        setProgress({ current: ++processedCount, total: totalFiles, fileName });

        const { result, error: importError } = await labImport(pages, unitSystem);
        if (result) {
          allResults.push({ fileName, ...result });
        } else {
          allResults.push({ fileName, reportDate: null, values: [], unrecognized: [], error: importError || 'Extraction failed' });
        }
      }

      setResults(allResults);
      setState('review');
    } catch (err) {
      if (!abort.signal.aborted) {
        console.error('Upload processing error:', err);
        setError('An error occurred while processing files. Please try again.');
        setState('select');
      }
    }
  };

  const handleCancel = () => {
    abortRef.current?.abort();
    if (results.length > 0) {
      setState('review');
    } else {
      setState('select');
    }
  };

  const handleSave = useCallback(async (
    selectedValues: Array<{ metric: string; valueSI: number; recordedAt: string }>,
  ) => {
    setIsSaving(true);
    try {
      const measurements = selectedValues.map(v => ({
        metricType: v.metric,
        value: v.valueSI,
        recordedAt: v.recordedAt,
        source: 'lab_import' as const,
      }));

      const saved = await bulkSaveMeasurements(measurements);
      setSavedCount(saved.length);

      if (saved.length > 0) {
        setState('done');
        onComplete();
      } else {
        setError('Failed to save values. Please try again.');
      }
    } finally {
      setIsSaving(false);
    }
  }, [onComplete]);

  return (
    <div className="upload-modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`upload-modal${isMobile ? ' upload-modal--mobile' : ''}`}>
        <div className="upload-modal-header">
          <h3>Upload Lab Results</h3>
          <button className="upload-modal-close" onClick={onClose} aria-label="Close">&times;</button>
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
                <p className="upload-dropzone-text">Drop lab reports here, or click to browse</p>
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
                  Extract Values
                </button>
              )}
            </div>
          )}

          {state === 'processing' && (
            <div className="upload-processing">
              <div className="upload-progress-bar">
                <div
                  className="upload-progress-fill"
                  style={{ width: `${progress.total ? (progress.current / progress.total) * 100 : 0}%` }}
                />
              </div>
              <p className="upload-progress-text">
                Processing file {progress.current} of {progress.total}...
              </p>
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
              onSave={handleSave}
              onCancel={onClose}
              isSaving={isSaving}
              error={error}
            />
          )}

          {state === 'done' && (
            <div className="upload-done">
              <div className="upload-done-icon">&#10003;</div>
              <p className="upload-done-text">Saved {savedCount} blood test value{savedCount !== 1 ? 's' : ''}</p>
              <button className="btn-primary upload-done-btn" onClick={onClose}>
                Done
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
