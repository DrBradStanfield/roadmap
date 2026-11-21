/**
 * The shared upload Save's counts, read from the engine's review and the upload state, never from a value (US-13
 * AC13, US-21 AC15): the same event names and keys the grid's Save sends today (lib/upload-save.ts,
 * components/ReviewTable.tsx `reviewCounts`). Not mounted yet (PR 3b).
 */
import { notSavedGroups } from '@roadmap/health-core/import-review';
import { UPLOAD_OUTCOME_MAX, type UploadReviewKey } from '@roadmap/health-core/product-events';
import type { LabUnitRefusal } from '@roadmap/health-core/record-edits';
import type { UploadState } from '@roadmap/health-core/upload-flow';
import { readFiles, type UploadReview } from '@roadmap/health-core/upload-review';

/** The labs the review did not send for their unit or number, each by its own refusal from the review's dry run, for
 *  `lab_unit_refused` (US-21 AC15), as the grid's Save counts them (import-review-view.ts `labRefusals`). A core value the
 *  write refuses is never in this group: the review holds it as unsure, blocking Save until it is cleared. */
export const labRefusalsAt = (review: UploadReview): LabUnitRefusal[] =>
  review.classification.values.flatMap((v) => (v.group === 'notSaved' && v.refusal && 'lab' in v.refusal ? [v.refusal.lab] : []));

/**
 * The `upload_review` row (US-13 AC13): counts only. `changed`: each value the person cleared, edited, typed into or
 * ticked to replace, by its group, as the grid counts the cells it touched. A zero is left out; `saved` is always sent.
 * `notSavedOpened` is not sent: the list has no disclosure to open (owner ruling, 2026-11-22; dropped with the story
 * at the mount).
 */
export function uploadReviewCounts(review: UploadReview, s: UploadState, showAll: boolean, saved: boolean): Partial<Record<UploadReviewKey, number>> {
  const values = review.classification.values;
  const files = new Map(review.labFiles.map((f, i) => [f.fileId, i]));
  const groupOf = new Map(values.map((v) => [`${v.file}:${v.ref}`, v.group]));
  let changedSure = 0;
  let changedUnsure = 0;
  for (const f of readFiles(s)) {
    const i = files.get(f.id);
    if (i === undefined) continue;
    const c = f.status.choices;
    const refs = new Set([...Object.keys(c.ticks).filter((r) => !c.ticks[r]), ...Object.keys(c.edits), ...Object.keys(c.typed ?? {}), ...Object.keys(c.replace)]);
    for (const ref of refs) {
      const group = groupOf.get(`${i}:${ref}`);
      if (group === 'sure') changedSure++;
      else if (group === 'unsure') changedUnsure++;
    }
  }
  const count = (group: string) => values.filter((v) => v.group === group).length;
  const counts: Partial<Record<UploadReviewKey, number>> = {
    sure: count('sure'), unsure: count('unsure'), notSaved: notSavedGroups(values).total, showAll: Number(showAll), changedSure, changedUnsure,
  };
  return {
    ...Object.fromEntries(Object.entries(counts).filter(([, n]) => n).map(([k, n]) => [k, Math.min(n!, UPLOAD_OUTCOME_MAX)])),
    saved: Number(saved),
  };
}
