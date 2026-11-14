/**
 * The upload counters' closed metadata (US-12 AC10, US-13 AC13), split out of
 * product-events.ts, which re-exports them. Like it, this file imports nothing.
 */
/** The `upload_outcome` counter's integer counts (US-12 AC10): files seen, then
 *  how each ended. `truncated` overlaps the rest and `valuesDropped` counts value
 *  rows the parse refused, not files; the others sum to `picked`. `refused` and
 *  `tooLong` are files Claude declined or stopped short on (US-15 AC34). `docx`
 *  counts the picked .docx files, a kind that overlaps the rest; `picturesOnly`
 *  is a .docx of pictures and no text (US-12 AC13). `undatedPrevious` counts
 *  value rows read from an undated previous column, not files (AC14).
 *  `unitsGuessed` counts values whose unit was guessed (AC16) and `unitsRefused`
 *  creatinine rows refused rather than guessed (AC15): values, not files.
 *  `valuesLimit` counts the values printed as a limit, such as "> 60": since
 *  US-12 AC20 they are saved, so no longer part of `valuesDropped` (AC19 counted
 *  them there). `valuesLimitUngraded` is how many of them the grading rule
 *  leaves undecided. Counts only; the tests behind that count ride in their own
 *  closed list, `limitUngradedTests` (AC20). `cancelled`: 1 for a run Cancel stopped mid-read. */
export const UPLOAD_OUTCOME_KEYS = ['picked', 'withValues', 'documentOnly', 'noValues', 'openFailed', 'tooLarge', 'truncated', 'serverError', 'limitError', 'refused', 'tooLong', 'valuesDropped', 'docx', 'picturesOnly', 'undatedPrevious', 'unitsGuessed', 'unitsRefused', 'valuesLimit', 'valuesLimitUngraded', 'cancelled'] as const;
export type UploadOutcomeKey = (typeof UPLOAD_OUTCOME_KEYS)[number];
/** The most one count may say; the server refuses more, so the client clamps. */
export const UPLOAD_OUTCOME_MAX = 1000;
/** The `upload_review` counter (US-13 AC13): one per import review end, Save
 *  or Cancel. `sure`, `unsure` and `notSaved` count the review's values by
 *  group; `changedSure` and `changedUnsure` the values the person cleared,
 *  edited or unticked in each; `showAll`, `notSavedOpened` and `saved` are 0
 *  or 1 (UPLOAD_REVIEW_FLAGS). Counts only: never a value, test, unit or file. */
export const UPLOAD_REVIEW_KEYS = ['sure', 'unsure', 'notSaved', 'showAll', 'notSavedOpened', 'changedSure', 'changedUnsure', 'saved'] as const;
export type UploadReviewKey = (typeof UPLOAD_REVIEW_KEYS)[number];
/** The `upload_review` keys that are 0 or 1. */
export const UPLOAD_REVIEW_FLAGS = ['showAll', 'notSavedOpened', 'saved'] as const satisfies readonly UploadReviewKey[];
