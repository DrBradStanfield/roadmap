import { useId, useMemo, useReducer } from 'react';
import { createPortal } from 'react-dom';
import { deleteDocument, getShownErase, readDocumentFile } from '../lib/roadmap-data';
import { DOCUMENT_TYPE_LABELS } from '@roadmap/health-core/document-path';
import { formatDocumentDate } from '../lib/document-format';
import { originalPreview } from '@roadmap/health-core/file-kinds';
import type { ApiDocument } from '../lib/api-types';
import { renderMarkdown } from '../lib/markdown';
import { useIsMobile } from '../lib/useIsMobile';
import { useModalDialog } from '../lib/use-dialog';

interface DocumentLightboxProps {
  doc: ApiDocument;
  onClose: () => void;
  onDeleted?: (docId: string) => void;
}

/** Delete asks once, then writes; any answer, a throw included, ends the write (US-14 AC9). */
export type DeleteStep = 'idle' | 'confirming' | 'deleting';
export function deleteTransition(state: DeleteStep, event: 'press' | 'settled'): DeleteStep {
  if (event === 'press') return state === 'idle' ? 'confirming' : state === 'confirming' ? 'deleting' : state;
  return state === 'deleting' ? 'idle' : state;
}

/** "View original file": reading, then opened, or failed with its notice (US-14 AC9). */
export type OriginalView = 'idle' | 'opening' | 'failed';
export function originalTransition(state: OriginalView, event: 'open' | 'opened' | 'missing'): OriginalView {
  if (event === 'open') return state === 'opening' ? state : 'opening';
  return state === 'opening' ? (event === 'opened' ? 'idle' : 'failed') : state;
}

export function DocumentLightbox({ doc, onClose, onDeleted }: DocumentLightboxProps) {
  // Two flows that run apart: a person may view the original while a delete waits for its confirm.
  const [deleteStep, sendDelete] = useReducer(deleteTransition, 'idle');
  const [original, sendOriginal] = useReducer(originalTransition, 'idle');
  const isMobile = useIsMobile(768);

  // A modal <dialog>, as the standalone's lightboxes are (US-09 AC34): the browser keeps the page behind
  // out of reach, Escape sends `cancel`, and the focus goes back to the opener (US-14 AC7a). The title
  // names it; a blank one shows "Untitled", the chat list's word, so the dialog always has a name.
  const dialogRef = useModalDialog();
  const titleId = useId();

  const renderedHtml = useMemo(() => {
    try {
      return renderMarkdown(doc.contentMd);
    } catch {
      return `<pre style="white-space:pre-wrap">${doc.contentMd.replace(/</g, '&lt;')}</pre>`;
    }
  }, [doc.contentMd]);

  // View the archived original (v2 local-first only — fileRef is absent on v1).
  const handleViewOriginal = async () => {
    if (!doc.fileRef || original === 'opening') return;
    sendOriginal('open');
    const blob = await readDocumentFile(doc.fileRef).catch(() => null);
    if (!blob) {
      sendOriginal('missing');
      return;
    }
    sendOriginal('opened');
    // Only a vetted passive type opens in a tab, re-typed by the shared table; anything else
    // (an SVG, HTML) would run script with this page's origin, so it downloads (US-14 AC3, AC14).
    const type = originalPreview(doc.fileRef, doc.mimeType ?? null, blob.type)?.type;
    const url = URL.createObjectURL(new Blob([blob], { type: type ?? 'application/octet-stream' }));
    if (type) {
      window.open(url, '_blank', 'noopener');
    } else {
      const link = document.createElement('a');
      link.href = url;
      link.download = doc.fileRef.split('/').pop() || 'document';
      document.body.appendChild(link);
      link.click();
      link.remove();
    }
    // Give the new tab or the download time to take the blob before revoking.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  const handleDelete = async () => {
    sendDelete('press');
    if (deleteStep !== 'confirming') return;
    const success = await deleteDocument(doc.id, getShownErase()).catch(() => false); // the erase shown at the press (US-16 AC2a)
    if (success) {
      onDeleted?.(doc.id);
      onClose();
    }
    sendDelete('settled');
  };

  // On <body>: `.health-tool` is transformed, so a fixed backdrop inside it would cover
  // the widget, not the screen (US-14 AC7). Outside the widget root it masks itself (US-09 AC8).
  return createPortal((
    <dialog ref={dialogRef} className="upload-modal-backdrop doc-lightbox-dialog" aria-labelledby={titleId} data-clarity-mask="true"
      onCancel={(e) => { e.preventDefault(); onClose(); }} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`upload-modal doc-lightbox${isMobile ? ' upload-modal--mobile' : ''}`}>
        <div className="upload-modal-header">
          <div className="doc-lightbox-title-row">
            <span className={`review-doc-type-badge review-doc-type--${doc.documentType}`}>
              {DOCUMENT_TYPE_LABELS[doc.documentType] || doc.documentType}
            </span>
            <h3 id={titleId} tabIndex={-1} data-initial-focus>{doc.title.trim() || 'Untitled'}</h3>
          </div>
          <button className="upload-modal-close" onClick={onClose} aria-label="Close">&times;</button>
        </div>

        <div className="doc-lightbox-date">
          {formatDocumentDate(doc.documentDate)}
          {doc.sourceFileName && (
            <span className="doc-lightbox-filename"> — {doc.sourceFileName}</span>
          )}
        </div>

        <div
          className="doc-lightbox-content"
          dangerouslySetInnerHTML={{ __html: renderedHtml }}
        />

        <div className="doc-lightbox-footer">
          {doc.fileRef && (
            <button className="doc-view-original-btn" onClick={handleViewOriginal} disabled={original === 'opening'}>
              {original === 'opening' ? 'Opening…' : 'View original file'}
            </button>
          )}
          {original === 'failed' && <span className="doc-view-original-error">Could not load the original file from your cloud storage.</span>}
          <button
            className={`doc-delete-btn${deleteStep !== 'idle' ? ' doc-delete-btn--confirm' : ''}`}
            onClick={handleDelete}
            disabled={deleteStep === 'deleting'}
          >
            {deleteStep === 'deleting' ? 'Deleting...' : deleteStep === 'confirming' ? 'Confirm Delete' : 'Delete Document'}
          </button>
        </div>
      </div>
    </dialog>
  ), document.body);
}
