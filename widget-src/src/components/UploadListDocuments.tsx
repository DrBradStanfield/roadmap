// The letters and documents an upload will save (US-14 AC11-13; web list PR 2), drawn from `uploadView().documents` as the
// iPhone draws them (UploadReviewView.swift `documentsRow`): each with its title, kind and date, changed through the
// engine's `{document: DocumentFix}`. The title is typed into the list's one draft (key `title:<fileId>`), so it commits
// as a value does. The date picker is the review's own (ReviewFileSections.tsx, DraftDateCell); "Document title" and
// "Document date" are that file's words.
import type { DocumentFix } from '@roadmap/health-core/upload-choices';
import type { UploadView } from '@roadmap/health-core/upload-view';
import { DraftDateCell } from './DraftDateCell';
import { draftKeys, type RowEvents } from './UploadListRow';

export const titleKey = (fileId: string) => `title:${fileId}`;

export function UploadListDocuments({ documents, titleOf, editable, on, fix }: {
  documents: NonNullable<UploadView['documents']>;
  /** The title input's text: the draft while it names this letter, else the engine's title. */
  titleOf: (fileId: string, title: string) => string;
  editable: boolean;
  on: RowEvents;
  fix: (fileId: string, change: DocumentFix) => void;
}) {
  return (
    <section className="upload-list-documents">
      <h4 className="review-check-title">{documents.line}</h4>
      <ul>
        {documents.rows.map((d) => (
          <li key={d.fileId} className="upload-list-document" data-doc={d.fileId} onFocus={() => on.focus(titleKey(d.fileId))}>
            <input
              type="text" className="review-title-input" placeholder="Document title" aria-label="Document title" disabled={!editable}
              value={titleOf(d.fileId, d.title)}
              onChange={(e) => on.type(titleKey(d.fileId), e.target.value)}
              onBlur={on.commit}
              onKeyDown={draftKeys(on)}
            />
            {documents.kinds && d.kindKey && (
              <select className="upload-list-kind" aria-label={d.kind} value={d.kindKey} disabled={!editable} onChange={(e) => fix(d.fileId, { kind: e.target.value })}>
                {documents.kinds.map((k) => <option key={k.key} value={k.key}>{k.word}</option>)}
              </select>
            )}
            <span className="upload-list-document-date">
              <DraftDateCell
                date={d.day ?? ''} needsDay={!d.dateKnown} placeholder={d.dateKnown ? undefined : documents.setDate ?? d.date}
                ariaLabel="Document date" disabled={!editable}
                onChange={(day) => { if (day) fix(d.fileId, { date: day }); }}
              />
              {d.dateKnown && documents.removeDate && (
                <button type="button" className="review-disclosure" disabled={!editable} onClick={() => fix(d.fileId, { date: null })}>{documents.removeDate}</button>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
