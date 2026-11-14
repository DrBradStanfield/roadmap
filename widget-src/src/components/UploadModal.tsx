import { useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { UnitSystem, MetricType } from '@roadmap/health-core/units';
import type { UploadHistory } from '../lib/api-types';
import { measurementRefusalLine } from '../lib/lab-value-labels';
import { labUnitRefusalLine } from '@roadmap/health-core/lab-series';
import { useLpaUnit } from '../lib/lpa-unit';
import type { Grading } from '../lib/blood-test-cell';
import { ReviewTable } from './ReviewTable';
import { FileNotices, NotSaved } from './UploadNotices';
import { ErrorBoundary } from './ErrorBoundary';
import { FloatingUploadIndicator } from './FloatingUploadIndicator';
import { useUploadFlow, MAX_FILES } from '../hooks/useUploadFlow';
import { getDocumentArchiveMode } from '../lib/roadmap-data';
import { useIsMobile } from '../lib/useIsMobile';
import { openBackendPicker, UPLOAD_STORAGE_NOTICE } from '../lib/storage-notice';
import { opensRow } from './ChatThreadList';

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

/** Enter or Space on the drop zone opens the file chooser, as a click does (US-12 AC1a). */
function browseOnKey(e: React.KeyboardEvent, input: HTMLInputElement | null): void {
  if (!opensRow(e)) return;
  e.preventDefault();
  input?.click();
}

export function UploadModal({ unitSystem, metricUnitOverrides, onToggleFieldUnit, history, onComplete, onStart, onClose, onScreeningUpdate, age, sex, grading, open, onOpen }: UploadModalProps) {
  const flow = useUploadFlow({ unitSystem, history, onComplete, onStart, onClose, onScreeningUpdate });
  const { phase, files, notices, progress, results, readError, saveError, skipArchive, close: handleClose, discard: handleDiscard } = flow;
  const picking = phase === 'picking' || phase === 'readFailed';
  const reviewing = phase === 'reviewing' || phase === 'saving' || phase === 'saveFailed';
  // Connect-first gate (decision record: encourage, don't block). 'device-only'
  // + not skipped → show the connect panel instead of the dropzone.
  const archiveMode = getDocumentArchiveMode();
  const { values: savedCount, labValues: savedLabCount, documents: { length: savedDocCount }, skippedValues: skippedMeasurements, skippedLabValues, unstored: unstoredCount, refusedLabUnits, refusedMeasurements } = flow.outcome;
  // Lp(a)'s refusal names its range in the unit its field shows (US-05 AC2).
  const [lpaUnit] = useLpaUnit(unitSystem);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isMobile = useIsMobile(768);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') handleClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [handleClose, open]);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    flow.pick(e.dataTransfer.files);
  };

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
    {!open && phase !== 'picking' && <FloatingUploadIndicator progress={progress} phase={phase} onClick={onOpen} />}
    {createPortal((
    <div className="upload-modal-backdrop" data-clarity-mask="true" style={!open ? { display: 'none' } : undefined} onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}>
      <div className={`upload-modal${isMobile ? ' upload-modal--mobile' : ''}`}>
        <div className="upload-modal-header">
          <h3>Upload Health Records</h3>
          <button className="upload-modal-close" onClick={handleClose} aria-label="Close">&times;</button>
        </div>

        <div className="upload-modal-body">
          {picking && archiveMode === 'device-only' && !skipArchive && (
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
              <button type="button" className="upload-connect-skip" onClick={flow.skipConnect}>
                Continue without keeping my files ›
              </button>
            </div>
          )}
          {picking && (archiveMode !== 'device-only' || skipArchive) && (
            <div className="upload-select">
              <div
                className="upload-dropzone"
                role="button"
                tabIndex={0}
                onDrop={handleDrop}
                onDragOver={(e) => e.preventDefault()}
                onClick={() => fileInputRef.current?.click()}
                onKeyDown={(e) => browseOnKey(e, fileInputRef.current)}
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
                onChange={(e) => flow.pick(e.target.files)}
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
              {readError && <p className="upload-error">{readError}</p>}
              <FileNotices notices={notices} />
            </div>
          )}

          {phase === 'reading' && (
            <div className="upload-processing">
              <div className="upload-progress-bar">
                <div
                  className="upload-progress-fill upload-progress-fill--smooth"
                  style={{ width: `${progress.current}%` }}
                >&nbsp;</div>
              </div>
              <p className="upload-progress-file">{progress.fileName}</p>
              <button className="btn-primary upload-cancel-btn" onClick={flow.cancel}>
                Cancel
              </button>
            </div>
          )}

          {reviewing && <><FileNotices notices={notices} /><NotSaved results={results} /></>}
          {reviewing && (
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
              onSave={flow.save}
              onCancel={handleDiscard}
              isSaving={phase === 'saving'}
              error={saveError}
              refusals={refusedLabUnits.length + refusedMeasurements.length > 0 ? refusalLines : undefined}
            />
            </ErrorBoundary>
          )}

          {phase === 'done' && (
            <div className="upload-done">
              <div className="upload-done-icon">&#10003;</div>
              <p className="upload-done-text">
                {savedCount > 0 && `Saved ${savedCount} blood test value${savedCount !== 1 ? 's' : ''}`}
                {savedCount > 0 && (savedLabCount > 0 || savedDocCount > 0) && ', '}
                {savedLabCount > 0 && `${savedLabCount} additional lab value${savedLabCount !== 1 ? 's' : ''}`}
                {savedLabCount > 0 && savedDocCount > 0 && ', '}
                {savedDocCount > 0 && `${savedDocCount} document${savedDocCount !== 1 ? 's' : ''}`}
                {savedCount === 0 && savedLabCount === 0 && savedDocCount === 0
                  && skippedMeasurements === 0 && skippedLabValues === 0
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
