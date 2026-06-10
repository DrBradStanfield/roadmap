import { useEffect, useMemo, useState } from 'react';
import { deleteDocument, readDocumentFile, DOCUMENT_TYPE_LABELS, formatDocumentDate, type ApiDocument } from '../lib/api';
import { renderMarkdown } from '../lib/markdown';
import { useIsMobile } from '../lib/useIsMobile';

interface DocumentLightboxProps {
  doc: ApiDocument;
  onClose: () => void;
  onDeleted?: (docId: string) => void;
}

export function DocumentLightbox({ doc, onClose, onDeleted }: DocumentLightboxProps) {
  const [isDeleting, setIsDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [isOpening, setIsOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
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
    if (!doc.fileRef || isOpening) return;
    setIsOpening(true);
    setOpenError(null);
    const blob = await readDocumentFile(doc.fileRef);
    setIsOpening(false);
    if (!blob) {
      setOpenError('Could not load the original file from your cloud storage.');
      return;
    }
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener');
    // Give the new tab time to take ownership of the blob before revoking.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  const handleDelete = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setIsDeleting(true);
    const success = await deleteDocument(doc.id);
    if (success) {
      onDeleted?.(doc.id);
      onClose();
    }
    setIsDeleting(false);
    setConfirmDelete(false);
  };

  return (
    <div className="upload-modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
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
            <button className="doc-view-original-btn" onClick={handleViewOriginal} disabled={isOpening}>
              {isOpening ? 'Opening…' : 'View original file'}
            </button>
          )}
          {openError && <span className="doc-view-original-error">{openError}</span>}
          <button
            className={`doc-delete-btn${confirmDelete ? ' doc-delete-btn--confirm' : ''}`}
            onClick={handleDelete}
            disabled={isDeleting}
          >
            {isDeleting ? 'Deleting...' : confirmDelete ? 'Confirm Delete' : 'Delete Document'}
          </button>
        </div>
      </div>
    </div>
  );
}
