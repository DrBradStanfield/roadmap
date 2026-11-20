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
 *  `hidden` values sit behind it, in `rows` rows (a row of the record's own
 *  values too); `line` is health-core's view's own count, the one Save's label
 *  comes from, so the two never part (PR 1906 smoke item B). */
export function SureLine({ hidden, rows, line, total, all, controls }: { hidden: number; rows: number; line: string | null; total: number; all: Disclosure; controls: string }) {
  // While open, "Hide" stays even once nothing is left to hide (an edit keeps its row in sight).
  if ((rows === 0 || total === 0) && !all.open) return null;
  return (
    <p className="review-overview-line">
      {hidden > 0 && line && <><span>{line}</span>{' '}</>}
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
