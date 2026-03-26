import { useEffect, useMemo, useState } from 'react';
import { deleteDocument, DOCUMENT_DOCUMENT_TYPE_LABELS, formatDocumentDate, type ApiDocument } from '../lib/api';
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
  const isMobile = useIsMobile(768);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const renderedHtml = useMemo(
    () => renderMarkdown(doc.contentMd),
    [doc.contentMd],
  );

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
