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
import { UPLOAD_TEXT } from './upload-text';
import { saveLabel } from './upload-view';

/**
 * `save`: the Save button's words, "Saving..." while it saves, else the view's label (`uploadView().save.label`).
 * `close`: "Close" when nothing could be saved, as the web's review says it (ReviewTable.tsx `nothingToSave`: no value
 * offered to save, ticked or cleared, and nothing the plan writes, letters and originals included), else "Cancel", as it
 * says while files are still read (UploadModal.tsx); while saving the same, as the review's close button shows it then,
 * disabled (ReviewTable.tsx:471-473, `disabled={isSaving}`; the view's `closeEnabled`); once done, the done screen's own
 * button, "Done" (`uploadView().doneLabel`, owner ruling on PR 1951). `letters`: each letter Save files, in the plan's order (the order of
 * `uploadView().documents.rows`), with the text Save writes (`contentMd`). That text is the reader's Markdown from an
 * uploaded file: data, shown as text only, never as HTML. The person's title, kind and date fixes change the fields
 * beside it, never the text.
 */
export interface ListPage { save: string; close: string; letters: Array<{ fileId: string; text: string }> }

export function uploadListPage(s: UploadState, record: RoadmapFile, now: string, review: UploadReview, cloudConnected: boolean): ListPage {
  const plan = uploadSavePlan(s, record, now, review, cloudConnected);
  const offered = review.classification.values.some((v) => isOfferedRef(v.ref) && (v.group === 'sure' || v.group === 'unsure' || v.group === 'waiting'));
  return {
    save: s.phase === 'saving' ? UPLOAD_TEXT.saving : saveLabel(plan),
    close: s.phase === 'done' ? UPLOAD_TEXT.done : inFlight(s) || offered || !planIsEmpty(plan) ? UPLOAD_TEXT.cancel : UPLOAD_TEXT.close,
    letters: plan.documents.map(({ fileId, fields }) => ({ fileId, text: fields.contentMd })),
  };
}
