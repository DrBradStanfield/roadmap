import { useRef, useEffect, useId, useMemo, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { UnitSystem, MetricType } from '@roadmap/health-core/units';
import { UPLOAD_TEXT } from '@roadmap/health-core/upload-text';
import { FileNotices } from './UploadNotices';
import { ErrorBoundary } from './ErrorBoundary';
import { FloatingUploadIndicator } from './FloatingUploadIndicator';
import { UploadReviewList } from './UploadReviewList';
import { useUploadFlow, MAX_FILES } from '../hooks/useUploadFlow';
import { getDocumentArchiveMode } from '../lib/roadmap-data';
import { useIsMobile } from '../lib/useIsMobile';
import { openBackendPicker, UPLOAD_STORAGE_NOTICE } from '../lib/storage-notice';
import type { ProductEventMetadata } from '../lib/server-api';

interface UploadModalProps {
  unitSystem: UnitSystem;
  metricUnitOverrides?: Partial<Record<MetricType, UnitSystem>>;
  /** useUnits' `setFieldUnit`: a row's unit press sets the unit its chip names (US-34 AC7a). */
  onSetFieldUnit?: (field: string, to: UnitSystem) => void;
  /** The page's re-read, after a Save's commit landed. */
  onComplete: () => void | Promise<void>;
  onStart?: () => Promise<void>;
  onClose: () => void;
  /** The plan's age, for a letter's screening box (US-06 AC5, US-13 AC6). */
  age?: number;
  sex?: 'male' | 'female';
  /** Visibility does not end the session or discard review drafts. */
  open: boolean;
  onOpen: () => void;
}

export function UploadModal({ unitSystem, metricUnitOverrides, onSetFieldUnit, onComplete, onStart, onClose, age, sex, open, onOpen }: UploadModalProps) {
  const person = useMemo(() => (age === undefined && sex === undefined ? undefined : { age, sex }), [age, sex]);
  const flow = useUploadFlow({ unitSystem, onComplete, onStart, onClose, person });
  const { phase, files, notices, progress, readError, skipArchive, engine } = flow;
  const picking = phase === 'picking' || phase === 'readFailed';
  // The list shows the files as each is read, the review, the Save and its done screen (US-12 AC26), once the upload
  // bundle has loaded the engine it draws with; before that, the reading screen's progress.
  const listed = !!engine && (phase === 'reading' || phase === 'reviewing' || phase === 'saving' || phase === 'saveFailed' || phase === 'done');
  const handleClose = flow.close;
  // A review that Cancel discards sends its counts; × and Escape only hide it, to
  // resume (US-12 AC4). The flow sends one per review, none while a Save runs (US-13 AC13).
  const handleDiscard = (counts?: ProductEventMetadata) => {
    if (phase === 'reviewing' || phase === 'saveFailed') flow.endReview(counts);
    flow.discard();
  };
  // Connect-first gate (decision record: encourage, don't block). 'device-only'
  // + not skipped → show the connect panel instead of the dropzone.
  const archiveMode = getDocumentArchiveMode();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isMobile = useIsMobile(768);
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const indicatorRef = useRef<HTMLDivElement>(null);
  useDialogFocus(open, dialogRef, titleRef, indicatorRef);

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

  // Portal to body so position:fixed resolves against the viewport — the
  // .health-tool container has a transform/contain that would otherwise pin
  // the modal inside the (very tall) widget root instead of the viewport.
  return <>
    {!open && phase !== 'picking' && <FloatingUploadIndicator progress={progress} phase={phase} onClick={onOpen} buttonRef={indicatorRef} />}
    {createPortal((
    <div className="upload-modal-backdrop" data-clarity-mask="true" style={!open ? { display: 'none' } : undefined} onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}>
      <div ref={dialogRef} className={`upload-modal${isMobile ? ' upload-modal--mobile' : ''}`} role="dialog" aria-modal={open} aria-labelledby={titleId}>
        <div className="upload-modal-header">
          <h3 id={titleId} ref={titleRef} tabIndex={-1}>Upload Health Records</h3>
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

          {phase === 'reading' && !listed && (
            <div className="upload-processing">
              <div className="upload-progress-bar">
                <div
                  className="upload-progress-fill upload-progress-fill--smooth"
                  style={{ width: `${progress.current}%` }}
                >&nbsp;</div>
              </div>
              <p className="upload-progress-file">{progress.fileName}</p>
              <button className="btn-primary upload-cancel-btn" onClick={flow.cancel}>
                {UPLOAD_TEXT.cancel}
              </button>
            </div>
          )}

          {listed && <FileNotices notices={flow.heldNotices} />}
          {listed && engine && (
            // A review that throws while rendering is never a dead widget (US-13 AC9).
            <ErrorBoundary feature="upload_review" fallback={
              <div className="upload-review-error" role="alert">
                <p>Something went wrong showing these results. Your file was read; please try again.</p>
                <button type="button" className="btn-primary" onClick={() => handleDiscard()}>Cancel</button>
              </div>
            }>
            <UploadReviewList
              flow={flow} engine={engine} unitSystem={unitSystem} metricUnitOverrides={metricUnitOverrides}
              setFieldUnit={onSetFieldUnit} person={person} discard={handleDiscard}
            />
            </ErrorBoundary>
          )}
        </div>
      </div>
    </div>
  ), document.body)}
  </>;
}

/** US-12 AC4a: opening the window moves the focus to its title. Hiding or removing it gives
 *  the focus back to what held it on opening, unless the focus has since gone somewhere
 *  outside the window (another dialog it opened). When that holder has left the page or was
 *  the page itself (the floating indicator leaves as the window shows), the focus goes to the
 *  floating indicator if hiding shows it. */
function useDialogFocus(open: boolean, dialogRef: RefObject<HTMLElement>, titleRef: RefObject<HTMLElement>, indicatorRef: RefObject<HTMLElement>) {
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement; // never null: the page has a body
    titleRef.current?.focus();
    return () => {
      const now = document.activeElement;
      const back = opener.isConnected && opener !== document.body ? opener : indicatorRef.current;
      if (now === document.body || dialogRef.current?.contains(now)) back?.focus();
    };
  }, [open]);
}
