import { createPortal } from 'react-dom';
import type { UploadPhase } from '../hooks/useUploadFlow';

/** Floating indicator shown when modal is hidden during processing.
 *  Portaled to body for the same reason as the modal — position:fixed must
 *  resolve against the viewport, not the transform'd .health-tool ancestor. */
export function FloatingUploadIndicator({ progress, phase, onClick }: {
  progress: { current: number; total: number; fileName: string };
  phase: UploadPhase;
  onClick: () => void;
}) {
  const label = phase === 'readFailed' || phase === 'saveFailed' ? 'Upload needs attention. Click to open'
    : phase === 'saving' ? 'Saving health records. Click to open'
    : phase === 'done' ? 'Health records saved. Click to open'
    : phase === 'reviewing' ? 'Ready for review. Click to open'
    : 'Processing health records...';
  return createPortal((
    <div className="floating-upload-indicator" onClick={onClick} role="button" tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}>
      <div className="floating-upload-text">{label}</div>
      {phase === 'reading' && (
        <div className="floating-upload-bar">
          <div className="floating-upload-fill upload-progress-fill--smooth" style={{ width: `${progress.current}%` }}>&nbsp;</div>
        </div>
      )}
    </div>
  ), document.body);
}
