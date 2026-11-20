import { useRef, useEffect, useId, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { UnitSystem, MetricType } from '@roadmap/health-core/units';
import { inFlight } from '@roadmap/health-core/upload-flow';
import { NO_CHOICES } from '@roadmap/health-core/upload-choices';
import type { DocumentResult } from '@roadmap/health-core/lab-extraction';
import { UPLOAD_WINDOW_TEXT } from '@roadmap/health-core/upload-text';
import type { UploadHistory } from '../lib/api-types';
import type { Grading } from '../lib/blood-test-cell';
import { ReviewTable } from './ReviewTable';
import { UploadReviewSections } from './UploadReviewSections';
import { FileNotices } from './UploadNotices';
import { ErrorBoundary } from './ErrorBoundary';
import { FloatingUploadIndicator } from './FloatingUploadIndicator';
import { useUploadFlow, MAX_FILES } from '../hooks/useUploadFlow';
import { getDocumentArchiveMode } from '../lib/roadmap-data';
import { useIsMobile } from '../lib/useIsMobile';
import { openBackendPicker, UPLOAD_STORAGE_NOTICE } from '../lib/storage-notice';
import type { ProductEventMetadata } from '../lib/server-api';

interface UploadModalProps {
  unitSystem: UnitSystem;
  metricUnitOverrides?: Partial<Record<MetricType, UnitSystem>>;
  onToggleFieldUnit?: (field: string) => void;
  history: UploadHistory;
  /** The page's re-read, after a Save lands (US-12 AC6). */
  onComplete: () => void | Promise<void>;
  onStart?: () => Promise<void>;
  onClose: () => void;
  /** The plan's age, for a letter's screening eligibility (US-06 AC5). */
  age?: number;
  sex?: 'male' | 'female';
  /** Whom the review's hints and colours grade for; null for a known minor (US-07 AC6). */
  grading: Grading;
  /** Visibility does not end the session or discard review drafts. */
  open: boolean;
  onOpen: () => void;
}

export function UploadModal({ unitSystem, metricUnitOverrides, onToggleFieldUnit, history, onComplete, onStart, onClose, age, sex, grading, open, onOpen }: UploadModalProps) {
  const flow = useUploadFlow({ unitSystem, history, onComplete, onStart, onClose, screening: { age, sex } });
  const { phase, state, view, review, files, notices, progress, readError, skipArchive } = flow;
  const picking = phase === 'picking' || phase === 'readFailed';
  // The review shows while files are still read: results appear as each one is (US-12 AC26).
  const reviewing = !!view && !!review && (phase === 'reading' || phase === 'reviewing' || phase === 'saving' || phase === 'saveFailed');
  const reading = inFlight(state) > 0;
  // A review that Cancel discards sends its counts; × and Escape only hide it, to
  // resume (US-12 AC4). The flow sends one per review, none while a Save runs (US-13 AC13).
  const reviewCounts = useRef<(() => ProductEventMetadata) | null>(null);
  const handleClose = flow.close;
  const handleDiscard = () => {
    // While files are read, Cancel stops them and drops the run, as before (US-12 AC28).
    if (reading) return flow.cancel();
    if (phase === 'reviewing' || phase === 'saveFailed') flow.endReview(reviewCounts.current?.());
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

  const filesOf = state.phase === 'choosing' ? [] : state.files;
  const choices = (review?.labFiles ?? []).map(l => {
    const f = filesOf.find(x => x.id === l.fileId);
    return f?.status.s === 'read' ? f.status.choices : NO_CHOICES;
  });
  const documentOf = (fileId: string): DocumentResult | null => {
    const f = filesOf.find(x => x.id === fileId);
    return f?.status.s === 'read' ? (f.status.extraction.document as DocumentResult | null) ?? null : null;
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
          <h3 id={titleId} ref={titleRef} tabIndex={-1}>{UPLOAD_WINDOW_TEXT.title}</h3>
          <button className="upload-modal-close" onClick={handleClose} aria-label={UPLOAD_WINDOW_TEXT.close}>&times;</button>
        </div>

        <div className="upload-modal-body">
          {picking && archiveMode === 'device-only' && !skipArchive && (
            <div className="upload-select upload-connect-first">
              <h3 className="upload-connect-title">{UPLOAD_WINDOW_TEXT.keepTitle}</h3>
              <p className="upload-connect-text">{UPLOAD_STORAGE_NOTICE}</p>
              <button
                type="button"
                className="upload-btn-primary"
                onClick={() => {
                  onClose();
                  openBackendPicker();
                }}
              >
                {UPLOAD_WINDOW_TEXT.keepChoose}
              </button>
              <button type="button" className="upload-connect-skip" onClick={flow.skipConnect}>
                {UPLOAD_WINDOW_TEXT.keepSkip}
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
                <p className="upload-dropzone-text">{UPLOAD_WINDOW_TEXT.drop}</p>
                <p className="upload-dropzone-hint">{UPLOAD_WINDOW_TEXT.dropHint(MAX_FILES)}</p>
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

          {reviewing && view.progress && (
            <div className="upload-processing">
              <div className="upload-progress-bar">
                <div
                  className="upload-progress-fill upload-progress-fill--smooth"
                  style={{ width: `${Math.round((view.progress.done / Math.max(view.progress.total, 1)) * 100)}%` }}
                >&nbsp;</div>
              </div>
              <p className="upload-progress-file">{view.progress.line}</p>
              {view.progress.zip && <p className="upload-progress-file">{view.progress.zip}</p>}
              {view.stop && <button className="btn-primary upload-cancel-btn" onClick={flow.stop}>{view.stop.label}</button>}
            </div>
          )}
          {reviewing && <FileNotices notices={flow.reviewNotices} />}
          {reviewing && (
            // A review that throws while rendering is never a dead widget (US-13 AC9).
            <ErrorBoundary feature="upload_review" fallback={
              <div className="upload-review-error" role="alert">
                <p>{UPLOAD_WINDOW_TEXT.reviewError}</p>
                <button type="button" className="btn-primary" onClick={handleDiscard}>{UPLOAD_WINDOW_TEXT.cancel}</button>
              </div>
            }>
            <ReviewTable
              results={flow.results}
              choices={choices}
              review={review}
              view={view}
              onChose={flow.chose}
              history={history}
              unitSystem={unitSystem}
              metricUnitOverrides={metricUnitOverrides}
              onToggleFieldUnit={onToggleFieldUnit}
              grading={grading}
              onSave={flow.save}
              onCancel={handleDiscard}
              isSaving={phase === 'saving'}
              countsRef={reviewCounts}
            >
              <UploadReviewSections view={view} documentOf={documentOf} failedLine={flow.failedLine} onChose={flow.chose} onRetry={flow.retry} />
            </ReviewTable>
            </ErrorBoundary>
          )}

          {phase === 'done' && view?.done && (
            <div className="upload-done">
              <div className="upload-done-icon">&#10003;</div>
              <p className="upload-done-text">{view.done.line}</p>
              {view.done.skipped.map(line => <p key={line} className="upload-done-skipped">{line}</p>)}
              {view.done.archived && <p className="upload-done-skipped">{view.done.archived}</p>}
              {view.done.unstored && <p className="upload-done-skipped">{view.done.unstored}</p>}
              <FileNotices notices={notices} />
              <button className="btn-primary upload-done-btn" onClick={handleClose}>
                {UPLOAD_WINDOW_TEXT.done}
              </button>
            </div>
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
