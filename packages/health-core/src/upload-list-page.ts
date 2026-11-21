/**
 * The web list's page around its rows (web list PR 1e; US-13 AC26, US-14 AC11-13): the Save and close buttons' words in
 * every phase, and each letter's text for its preview, so the screen branches on no phase and reads no plan. A companion
 * to `uploadList`, called with `uploadView`'s arguments: all three need the save plan and its cloud, which `uploadList`
 * does not take, and a new key on `uploadView` would reach the iPhone's page. The phone never calls it.
 * Cost: one save plan, as `uploadView` makes.
 */
import { isOfferedRef } from './import-review';
import type { RoadmapFile } from './roadmap-file';
import { inFlight, type UploadState } from './upload-flow';
import { planIsEmpty, uploadSavePlan } from './upload-plan';
import type { UploadReview } from './upload-review';
import { SCREENING_BOX_TEXT, type ScreeningPerson } from './upload-screening';
import { UPLOAD_TEXT } from './upload-text';
import { documentDateLine, saveLabel } from './upload-view';

/**
 * `save`: the Save button's words, "Saving..." while it saves, else the view's label (`uploadView().save.label`).
 * `close`: "Close" when nothing could be saved, as the web's review says it (ReviewTable.tsx `nothingToSave`: no value
 * offered to save, ticked or cleared, and nothing the plan writes, letters and originals included), else "Cancel", as it
 * says while files are still read (UploadModal.tsx); while saving the same, as the review's close button shows it then,
 * disabled (ReviewTable.tsx:471-473, `disabled={isSaving}`; the view's `closeEnabled`); once done, the done screen's own
 * button, "Done" (`uploadView().doneLabel`, owner ruling on PR 1951). `letters`: each letter Save files, in the plan's order (the order of
 * `uploadView().documents.rows`), with the text Save writes (`contentMd`). That text is the reader's Markdown from an
 * uploaded file: data, shown as text only, never as HTML. The person's title, kind and date fixes change the fields
 * beside it, never the text. `preview`: the text as the grid previews it (`letterPreview`), so no reader hears a whole
 * letter. `pickerLine`: what its date button shows, keyed here by `fileId` rather than on `uploadView().documents.rows`,
 * which the iPhone draws: its date in words, else "Set the date", as the phone's documents row shows it. `screening`: the
 * letter's screening box (US-13 AC6, web only, upload-screening.ts) in the web review's words, the type between `lead`
 * and `tail` drawn bold; `checked` only with a date, `disabled` without one, as the grid drew it; absent, no box.
 */
export interface ScreeningLine { lead: string; type: string; tail: string; checked: boolean; disabled: boolean }
export interface ListPage { save: string; close: string; letters: Array<{ fileId: string; text: string; preview: string; pickerLine: string; screening?: ScreeningLine }> }

/** A letter's preview, the grid's cut (moved from ReviewFileSections.tsx): its first 300 characters, then "..." when there
 *  is more; 300 or fewer, the whole text and no "...". */
export const letterPreview = (text: string): string => (text.length > 300 ? `${text.slice(0, 300)}...` : text);

/** `person`: the web's plan's age and sex, for each letter's screening box (none without it). */
export function uploadListPage(s: UploadState, record: RoadmapFile, now: string, review: UploadReview, cloudConnected: boolean, person?: ScreeningPerson): ListPage {
  const plan = uploadSavePlan(s, record, now, review, cloudConnected, person);
  const offered = review.classification.values.some((v) => isOfferedRef(v.ref) && (v.group === 'sure' || v.group === 'unsure' || v.group === 'waiting'));
  return {
    save: s.phase === 'saving' ? UPLOAD_TEXT.saving : saveLabel(plan),
    close: s.phase === 'done' ? UPLOAD_TEXT.done : inFlight(s) || offered || !planIsEmpty(plan) ? UPLOAD_TEXT.cancel : UPLOAD_TEXT.close,
    letters: plan.documents.map(({ fileId, fields, screening: box }) => ({
      fileId, text: fields.contentMd, preview: letterPreview(fields.contentMd),
      pickerLine: fields.documentDate === null ? UPLOAD_TEXT.setDate : documentDateLine(fields.documentDate),
      ...(box ? { screening: { lead: SCREENING_BOX_TEXT.lead, type: box.type, tail: SCREENING_BOX_TEXT.tail(box.date), checked: !!box.date && box.ticked, disabled: !box.date } } : {}),
    })),
  };
}
