import { useEffect, useMemo, useReducer } from 'react';
import { createPortal } from 'react-dom';
import { deleteDocument, readDocumentFile } from '../lib/roadmap-data';
import { DOCUMENT_TYPE_LABELS } from '@roadmap/health-core/document-path';
import { formatDocumentDate } from '../lib/document-format';
import { viewableType } from '../lib/file-kinds';
import type { ApiDocument } from '../lib/api-types';
import { renderMarkdown } from '../lib/markdown';
import { useIsMobile } from '../lib/useIsMobile';

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

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

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
    // Only a vetted passive type opens in a tab; anything else (an SVG, HTML)
    // would run script with this page's origin, so it downloads (US-14 AC3).
    const type = viewableType(doc.fileRef, blob.type);
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
    const success = await deleteDocument(doc.id).catch(() => false);
    if (success) {
      onDeleted?.(doc.id);
      onClose();
    }
    sendDelete('settled');
  };

  // On <body>: `.health-tool` is transformed, so a fixed backdrop inside it would cover
  // the widget, not the screen (US-14 AC7). Outside the widget root it masks itself (US-09 AC8).
  return createPortal((
    <div className="upload-modal-backdrop" data-clarity-mask="true" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`upload-modal doc-lightbox${isMobile ? ' upload-modal--mobile' : ''}`}>
        <div className="upload-modal-header">
          <div className="doc-lightbox-title-row">
            <span className={`review-doc-type-badge review-doc-type--${doc.documentType}`}>
              {DOCUMENT_TYPE_LABELS[doc.documentType] || doc.documentType}
            </span>
            <h3>{doc.title}</h3>
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
    </div>
  ), document.body);
}
