/**
 * The `upload_review` row (US-13 AC13), from the shared review and the person's choices: counts only, never a value,
 * test, unit or file. `sure`, `unsure` and `notSaved` count the review's values by group; `changedSure` and
 * `changedUnsure` the values the person cleared, edited, typed into or ticked to replace, by the group each is in now;
 * `showAll` whether they opened "Show all"; `saved` whether the review ended in a Save. A zero count is left out;
 * `saved` is always sent. The list has no "Not saved" disclosure, so `notSavedOpened` is no longer sent (mount 3b).
 */
import { notSavedGroups } from '@roadmap/health-core/import-review';
import { UPLOAD_OUTCOME_MAX, type UploadReviewKey } from '@roadmap/health-core/product-events';
import type { UploadState } from '@roadmap/health-core/upload-flow';
import { readFiles, type UploadReview } from '@roadmap/health-core/upload-review';

export function reviewCounts(review: UploadReview, s: UploadState, showAll: boolean, saved: boolean): Partial<Record<UploadReviewKey, number>> {
  const values = review.classification.values;
  const groupOf = new Map(values.map((v) => [`${review.labFiles[v.file]?.fileId}:${v.ref}`, v.group]));
  const changed = new Set<string>();
  for (const f of readFiles(s)) {
    const c = f.status.choices;
    const refs = [...Object.keys(c.ticks).filter((ref) => !c.ticks[ref]), ...Object.keys(c.edits), ...Object.keys(c.typed ?? {}), ...Object.keys(c.replace)];
    for (const ref of refs) changed.add(`${f.id}:${ref}`);
  }
  let changedSure = 0;
  let changedUnsure = 0;
  for (const id of changed) {
    const group = groupOf.get(id);
    if (group === 'sure') changedSure++;
    else if (group === 'unsure') changedUnsure++;
  }
  const counts: Partial<Record<UploadReviewKey, number>> = {
    sure: values.filter((v) => v.group === 'sure').length, unsure: values.filter((v) => v.group === 'unsure').length,
    notSaved: notSavedGroups(values).total, showAll: Number(showAll), changedSure, changedUnsure,
  };
  return {
    ...Object.fromEntries(Object.entries(counts).filter(([, n]) => n).map(([k, n]) => [k, Math.min(n!, UPLOAD_OUTCOME_MAX)])),
    saved: Number(saved),
  };
}
