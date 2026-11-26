// The letters and documents an upload will save (US-14 AC11-13; web list PR 2), drawn from `uploadView().documents` as the
// iPhone draws them (UploadReviewView.swift `documentsRow`): each with its file, title, kind, date and text, changed through the
// engine's `{document: DocumentFix}`. The title is typed into the list's one draft (key `title:<fileId>`), so it commits
// as a value does. "Document title", "Date:" and "Document date" are the old grid's words (ReviewFileSections.tsx, gone
// with the mount). Each control is named with its letter's file, so two letters read apart.
import { useId } from 'react';
import type { DocumentFix } from '@roadmap/health-core/upload-choices';
import type { ListPage } from '@roadmap/health-core/upload-list-page';
import type { UploadView } from '@roadmap/health-core/upload-view';
import { ListDatePicker } from './UploadListDatePicker';
import { draftKeys, type RowEvents } from './UploadListRow';

export const titleKey = (fileId: string) => `title:${fileId}`;
type Letters = NonNullable<UploadView['documents']>;

function Letter({ d, documents, fileName, title, page, editable, on, fix }: {
  d: Letters['rows'][number]; documents: Letters; fileName: string; title: string; page: ListPage['letters'][number] | undefined; editable: boolean; on: RowEvents; fix: (change: DocumentFix) => void;
}) {
  const id = useId();
  const [fileId, titleId, dateId] = ['file', 'title', 'date'].map((p) => `${id}${p}`);
  return (
    <li className="upload-list-document" data-doc={d.fileId} onFocus={() => on.focus(titleKey(d.fileId))}>
      <span id={fileId} className="upload-list-file-name">{fileName}</span>
      <label id={titleId} htmlFor={`${id}input`} className="upload-list-document-label">Document title</label>
      <input
        id={`${id}input`} type="text" className="review-title-input" disabled={!editable} value={title} aria-labelledby={`${titleId} ${fileId}`}
        onChange={(e) => on.type(titleKey(d.fileId), e.target.value, null, null)}
        onBlur={on.commit}
        onKeyDown={draftKeys(on)}
      />
      {documents.kinds && d.kindKey && (
        <select className="review-title-input upload-list-kind" aria-labelledby={fileId} value={d.kindKey} disabled={!editable} onChange={(e) => fix({ kind: e.target.value })}>
          {documents.kinds.map((k) => <option key={k.key} value={k.key}>{k.word}</option>)}
        </select>
      )}
      <span className="upload-list-document-date">
        <span>Date:</span>
        <ListDatePicker
          value={d.day ?? ''} empty={!d.dateKnown} name="Document date" describedBy={fileId} disabled={!editable}
          shown={{ id: dateId, text: page?.pickerLine ?? '' }}
          onDay={(day) => fix({ date: day })}
          // Cleared is unknown, the same change "Remove the date" sends (US-13 AC6, ReviewFileSections.tsx).
          onClear={() => fix({ date: null })}
        />
        {d.dateKnown && documents.removeDate && (
          <button type="button" className="upload-list-remove-date" disabled={!editable} onClick={() => fix({ date: null })}>{documents.removeDate}</button>
        )}
      </span>
      {/* The engine's preview of the reader's Markdown (the grid's cut), as plain text, never HTML, in the grid's box. */}
      {page && <div className="review-document-preview upload-list-letter-text">{page.preview}</div>}
      {/* The letter's screening box, as the engine words and ticks it (US-13 AC6, web only, upload-screening.ts). */}
      {page?.screening && (
        <label className="review-screening-update">
          <input type="checkbox" checked={page.screening.checked} disabled={!editable || page.screening.disabled} aria-describedby={fileId} onChange={(e) => fix({ screening: e.target.checked })} />
          <span>{page.screening.lead}<strong>{page.screening.type}</strong>{page.screening.tail}</span>
        </label>
      )}
    </li>
  );
}

export function UploadListDocuments({ documents, names, letters, titleOf, editable, on, fix }: {
  documents: Letters;
  /** Each letter's preview and date button words, from `uploadListPage().letters`. */
  letters: ListPage['letters'];
  /** Each letter's file name by file id (`uploadView().files`): the documents carry none of their own. */
  names: ReadonlyMap<string, string>;
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
          <Letter key={d.fileId} d={d} documents={documents} fileName={names.get(d.fileId) ?? ''} title={titleOf(d.fileId, d.title)}
            page={letters.find((l) => l.fileId === d.fileId)}
            editable={editable} on={on} fix={(change) => fix(d.fileId, change)} />
        ))}
      </ul>
    </section>
  );
}
