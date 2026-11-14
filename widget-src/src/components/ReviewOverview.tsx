// The import review's lines around the matrix (US-13 AC13): what Save writes
// unseen behind "Show all", what the record already holds, and "Not saved" as
// one line that opens to its reasons. Words: health-core IMPORT_REVIEW_TEXT.
import { useId, useState } from 'react';
import { IMPORT_REVIEW_TEXT } from '@roadmap/health-core/import-review';
import type { ReviewGroups } from '../lib/import-review-view';

/** A plain view toggle that also remembers it was ever opened, for `upload_review`. */
export function useDisclosure() {
  const [state, setState] = useState({ open: false, opened: false });
  return { ...state, toggle: () => setState(s => ({ open: !s.open, opened: true })) };
}
export type Disclosure = ReturnType<typeof useDisclosure>;

/** "{n} values will be saved", and the button that shows or hides them.
 *  `hidden` values sit behind it; `saving` of them are not cleared. */
export function SureLine({ hidden, saving, total, all, controls }: { hidden: number; saving: number; total: number; all: Disclosure; controls: string }) {
  if (hidden === 0) return null;
  return (
    <p className="review-overview-line">
      <span>{IMPORT_REVIEW_TEXT.willSave(saving)}</span>{' '}
      <button type="button" className="review-disclosure" aria-expanded={all.open} aria-controls={controls} onClick={all.toggle}>
        {all.open ? IMPORT_REVIEW_TEXT.hide : IMPORT_REVIEW_TEXT.showAll(total)}
      </button>
    </p>
  );
}

/** "{n} values not saved", opening to one line per reason, each test by its label (D5). */
export function NotSavedLine({ notSaved, disclosure }: { notSaved: ReviewGroups['notSaved']; disclosure: Disclosure }) {
  const id = useId();
  if (notSaved.total === 0) return null;
  return (
    <div className="review-not-saved">
      <button type="button" className="review-disclosure" aria-expanded={disclosure.open} aria-controls={id} onClick={disclosure.toggle}>
        {IMPORT_REVIEW_TEXT.notSavedTitle(notSaved.total)}
      </button>
      <div id={id} hidden={!disclosure.open}>
        <ul aria-label="Values not saved">
          {notSaved.lines.map(line => <li key={line.reason}>{line.text}</li>)}
          {notSaved.other && <li>{notSaved.other}</li>}
        </ul>
        <p className="review-overview-footer">{IMPORT_REVIEW_TEXT.notSavedFooter}</p>
      </div>
    </div>
  );
}

/** The Save button's words: "Save 3 values", then any documents and originals (string 12). */
export function saveLabel(values: number, documents: number, originals: number): string {
  const extras = [
    documents > 0 && `${documents} document${documents !== 1 ? 's' : ''}`,
    originals > 0 && `${originals} original${originals !== 1 ? 's' : ''}`,
  ].filter(Boolean);
  if (values > 0) return [IMPORT_REVIEW_TEXT.save(values), ...extras].join(' + ');
  return extras.length ? `Save ${extras.join(' + ')}` : 'Save';
}
