// The upload review's sections after "Not saved", drawn from health-core's view (design PR 10;
// US-12 AC26, US-13 AC14, AC6, US-06 AC5): the files not read, each with Try again where a retry
// can help; the letters and documents Save files, each correctable before Save; and the pick's
// files with their status, the ones already in the record included. Every word is the view's.
import { useState } from 'react';
import type { ChoiceChange } from '@roadmap/health-core/upload-choices';
import type { DocumentResult } from '@roadmap/health-core/lab-extraction';
import { UPLOAD_TEXT, UPLOAD_WINDOW_TEXT } from '@roadmap/health-core/upload-text';
import type { UploadView } from '@roadmap/health-core/upload-view';
import { DraftDateCell } from './DraftDateCell';
import { DocumentContent } from './DocumentLightbox';
import { KIND_WORDS } from '@roadmap/health-core/import-review';
import { DOCUMENT_TYPES } from '@roadmap/health-core/validation';
import { useDisclosure } from './ReviewOverview';
import { pastDay } from '../lib/review-dates';

interface UploadReviewSectionsProps {
  view: UploadView;
  /** A read letter's extraction, by file id: its kind and the start of its text. */
  documentOf: (fileId: string) => DocumentResult | null;
  /** A failed file's words, when the web has its own (a .docx of pictures, a legacy .doc). */
  failedLine: (fileId: string) => string | null;
  onChose: (fileId: string, change: ChoiceChange) => void;
  onRetry: (id: string | 'all') => void;
}

export function UploadReviewSections({ view, documentOf, failedLine, onChose, onRetry }: UploadReviewSectionsProps) {
  const failed = view.sections.find((s) => s.kind === 'failed');
  const documents = useDisclosure();
  const files = useDisclosure();
  // A title as typed: an input's own buffer; the state holds it, an empty one as the letter's own.
  const [titles, setTitles] = useState<Record<string, string>>({});
  return (
    <>
      {failed?.kind === 'failed' && (
        <div className="review-file-section review-failed-files">
          <h4 className="review-check-title">{failed.title}</h4>
          <ul>
            {failed.rows.map((row) => (
              <li key={row.fileId}>
                <span className="review-file-name" id={`failed-${row.fileId}`}>{row.name}</span>{' '}
                <span className="review-file-error">{failedLine(row.fileId) ?? row.line}</span>
                {row.retry && <button type="button" className="review-retry-btn" aria-describedby={`failed-${row.fileId}`} onClick={() => onRetry(row.fileId)}>{row.retry}</button>}
              </li>
            ))}
          </ul>
          {failed.retry && failed.rows.filter((r) => r.retry).length > 1 && (
            <button type="button" className="review-retry-btn" onClick={() => onRetry('all')}>{failed.retry}</button>
          )}
        </div>
      )}

      {/* Each letter's screening update, outside the collapsed list, so no date is written from a letter
          the person never saw offered (US-06 AC5; owner ruling on PR 1906). */}
      {view.documents?.rows.map((row) => row.screening && (
        <label key={row.fileId} className="review-screening-update">
          <input
            type="checkbox"
            checked={row.screening.checked}
            disabled={!row.screening.enabled}
            onChange={(e) => onChose(row.fileId, { screening: e.target.checked })}
          />
          <span>{row.screening.words[0]}<strong>{row.screening.words[1]}</strong>{row.screening.words[2]}</span>
        </label>
      ))}

      {view.documents && (
        <div className="review-documents">
          <button type="button" className="review-disclosure" aria-expanded={documents.open} onClick={documents.toggle}>{view.documents.line}</button>
          {documents.open && view.documents.rows.map((row) => {
            const doc = documentOf(row.fileId);
            const day = row.dateKnown ? row.date.slice(0, 10) : '';
            return (
              <div key={row.fileId} className="review-file-section">
                <div className="review-document-card">
                  <div className="review-document-header">
                    {/* The kind it saves as, correctable (US-13 AC14): no label word exists, so the control is named by the letter and its kind. */}
                    <select
                      className={`review-doc-type-badge review-doc-kind review-doc-type--${row.type}`}
                      value={row.type}
                      aria-label={`${row.title}, ${row.kind}`}
                      onChange={(e) => onChose(row.fileId, { document: { kind: e.target.value } })}
                    >
                      {DOCUMENT_TYPES.map((type) => <option key={type} value={type}>{KIND_WORDS[type][0]}</option>)}
                    </select>
                  </div>
                  <div className="review-document-title">
                    <input
                      type="text"
                      value={titles[row.fileId] ?? row.title}
                      onChange={(e) => {
                        const title = e.target.value;
                        setTitles((prev) => ({ ...prev, [row.fileId]: title }));
                        onChose(row.fileId, { document: { title: title.trim() ? title : undefined } });
                      }}
                      className="review-title-input"
                      placeholder={UPLOAD_WINDOW_TEXT.documentTitle}
                    />
                  </div>
                  <div className="review-file-date">
                    <span>{UPLOAD_WINDOW_TEXT.date}</span>
                    {/* No day: an empty picker saying so, so any day picked sets it (US-13 AC6). */}
                    <DraftDateCell
                      date={day}
                      needsDay={!row.dateKnown}
                      placeholder={row.dateKnown ? undefined : UPLOAD_TEXT.noDate}
                      ariaLabel={UPLOAD_WINDOW_TEXT.documentDate}
                      onChange={(picked) => {
                        // Cleared is no date; a day not yet happened is refused, never written.
                        const date = pastDay(picked);
                        if (!picked || date) onChose(row.fileId, { document: { date: picked ? date : null } });
                      }}
                    />
                  </div>
                  {/* The whole rebuilt letter, as the document page draws it, its links inert (US-13 AC14). */}
                  {doc && <DocumentContent markdown={doc.contentMarkdown} links={false} className="doc-lightbox-content review-document-letter" />}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {view.files.rows.length > 0 && (
        <div className="review-files">
          <button type="button" className="review-disclosure" aria-expanded={files.open} onClick={files.toggle}>{view.files.row}</button>
          {files.open && (
            <ul>
              {view.files.rows.map((row) => <li key={row.fileId}><span className="review-file-name">{row.name}</span> {row.status}</li>)}
            </ul>
          )}
        </div>
      )}
    </>
  );
}
