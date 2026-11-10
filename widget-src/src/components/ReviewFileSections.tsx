import { isScreeningEligible } from '@roadmap/health-core/types';
import { DraftDateCell } from './DraftDateCell';
import { type FullDate, pastDay, fullDateToIso } from '../lib/review-dates';
import type { ReviewDocuments } from '../hooks/useReviewDocuments';

interface ReviewFileSectionsProps {
  docs: ReviewDocuments;
  /** The files' report dates: a document's picker falls back to its file's. */
  fileDates: Record<string, FullDate>;
  /** The plan's age and sex, which set screening eligibility (US-06 AC5). */
  age?: number;
  sex?: 'male' | 'female';
}

/** The upload review's per-file sections, after the value matrix. */
export function ReviewFileSections({ docs, fileDates, age: userAge, sex }: ReviewFileSectionsProps) {
  const { docChecked, setDocChecked, documentDates, setDocumentDates, screeningDateFor, docTitles, setDocTitles, screeningChecked, setScreeningChecked } = docs;
  return (
    <>
      {docs.sortedResults.map(({ r, fi }) => {
        // After the matrix, the per-file section only renders for:
        //   - documents (scan results, clinic letters, …)
        //   - error rows (file failed to parse)
        //   - value-only files with NOTHING shown by the matrix (rare, e.g.
        //     LLM returned `values:[]` and `additionalValues:[]` — show
        //     "No values found" so the upload doesn't appear ignored).
        const hasNothingForMatrix = !r.error && !r.document && r.values.length === 0 && r.additionalValues.length === 0;
        if (!r.error && !r.document && !hasNothingForMatrix) return null;

        const documentDate = documentDates[fi]?.day ?? null;
        const month = documentDates[fi]?.month;
        const screeningDate = screeningDateFor(fi);
        const isDocDup = r.document ? docs.isSaved(r) : false;

        return (
          <div key={fi} className="review-file-section">
            <div className="review-file-header">
              <span className="review-file-name">{r.fileName}</span>
            </div>

            {r.error ? (
              <p className="review-file-error">Could not read this file: {r.error}</p>
            ) : r.document ? (
              <div className="review-document-card">
                <div className="review-document-header">
                  <label className="review-row-check">
                    <input
                      type="checkbox"
                      checked={docChecked[fi] ?? false}
                      onChange={(e) => setDocChecked(prev => ({ ...prev, [fi]: e.target.checked }))}
                    />
                  </label>
                  <span className={`review-doc-type-badge review-doc-type--${r.document.classification}`}>
                    {r.document.classification.replace(/_/g, ' ')}
                  </span>
                  {isDocDup && <span className="review-row-dup">Already saved</span>}
                </div>

                <div className="review-document-title">
                  <input
                    type="text"
                    value={docTitles[fi] || ''}
                    onChange={(e) => setDocTitles(prev => ({ ...prev, [fi]: e.target.value }))}
                    className="review-title-input"
                    placeholder="Document title"
                  />
                </div>

                <div className="review-file-date">
                  <span>Date:</span>
                  {/* No day: an empty picker, "— Jun '24" for a month alone
                      or "Date unknown", so any day picked sets it (US-13 AC6). */}
                  <DraftDateCell
                    date={documentDate ?? (month ? `${month}-01` : fullDateToIso(fileDates[fi]))}
                    needsDay={!documentDate}
                    placeholder={documentDate || month ? undefined : 'Date unknown'}
                    ariaLabel="Document date"
                    onChange={picked => {
                      // Cleared is unknown, its month too; a day not yet happened is refused, never written.
                      const day = pastDay(picked);
                      if (!picked || day) setDocumentDates(prev => ({ ...prev, [fi]: { day, month: null } }));
                    }}
                  />
                </div>

                <div className="review-document-preview">
                  {r.document.contentMarkdown.slice(0, 300)}
                  {r.document.contentMarkdown.length > 300 && '...'}
                </div>

                {!!r.document.metadata?.screeningType && isScreeningEligible(String(r.document.metadata.screeningType), userAge, sex) && (
                  <label className="review-screening-update">
                    <input
                      type="checkbox"
                      checked={!!screeningDate && (screeningChecked[fi] ?? false)}
                      disabled={!screeningDate}
                      onChange={(e) => setScreeningChecked(prev => ({ ...prev, [fi]: e.target.checked }))}
                    />
                    <span>
                      Update <strong>{String(r.document.metadata.screeningType)}</strong> screening date
                      {screeningDate ? ` to ${screeningDate}` : ' (pick the document date first)'}
                    </span>
                  </label>
                )}
              </div>
            ) : (
              <p className="review-no-values">No blood test values or document found in this file</p>
            )}
          </div>
        );
      })}
    </>
  );
}
