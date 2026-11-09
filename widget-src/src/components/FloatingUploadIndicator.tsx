import { createPortal } from 'react-dom';

export type ModalState = 'select' | 'processing' | 'review' | 'done' | 'error';

/** Floating indicator shown when modal is hidden during processing.
 *  Portaled to body for the same reason as the modal — position:fixed must
 *  resolve against the viewport, not the transform'd .health-tool ancestor. */
export function FloatingUploadIndicator({ progress, state, onClick }: {
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
