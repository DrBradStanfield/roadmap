// The iPhone's import review groups (US-13 AC13, US-52 AC8; design:
// docs/drafts/import-review-redesign.md, series PRs 5 and 6). Which of one
// report's values need a look, which save with no row, which are already in the
// record and which are not saved, and every word the screen shows, from
// health-core's one rule (import-review.ts). Swift asks again whenever a tick or
// the test day changes, so it holds no rule and no copy of these words. The only
// call into the shared classifier is `classifyReport` below, which the save uses too.
import type { RoadmapFile } from '../../packages/health-core/src/roadmap-file';
import { validDay, type BulkRow } from '../../packages/health-core/src/record-edits';
import {
  classifyImportValues, importRow, importSummary, importSummaryText, notSavedGroups, valueDays,
  IMPORT_REVIEW_TEXT, type ImportClassification, type ImportFile, type UnsureReason,
} from '../../packages/health-core/src/import-review';
import { createEmptyFile } from '../../packages/health-core/src/roadmap-file';
import { refusalWords, type Extraction } from './lab-review';

/** One offered value (`v<i>` or `a<i>`, the review's item refs) and its group. */
export interface GroupedItem {
  ref: string;
  group: 'sure' | 'unsure' | 'saved' | 'notSaved' | 'waiting';
  /** Unsure only: why it gets a row. */
  reasons?: UnsureReason[];
  /** The record already holds a different value for its day: shown, never written (Q2a). */
  conflict?: string;
  /** Outside its range: the write's own refusal line, shown on the row (US-52 AC8). */
  refusal?: string;
}

export interface LabReviewGroups {
  /** The summary line (strings 1 to 3). */
  summary: string;
  items: GroupedItem[];
  /** "Check these {k} values" and its footer; null with no unsure value. */
  check: { title: string; footer: string } | null;
  /** The sure values: "{n} values will be saved" (ticked ones), "Show all {n}", "Hide"; null with none. */
  sure: { willSave: string; showAll: string; hide: string } | null;
  /** "{n} already in your record"; null with none. */
  alreadySaved: string | null;
  /** "{n} values not saved", one line per reason with the tests' labels, and the footer; null with none. */
  notSaved: { title: string; lines: string[]; footer: string } | null;
  /** The extraction's own refused and unread rows (never a value the person ticks), as
   *  save all's notes name them after the save's own refusals (US-52 AC8b). */
  omitted: string[];
  /** The ticked values the save writes, in its order: never one held or refused (`classifyReport`'s rows). */
  saveRefs: string[];
  /** "Save {n} values", n = saveRefs' count; null when no value could be written, ticked or
   *  not (D3, nothing to save: the screen offers no Save). */
  save: string | null;
}

/**
 * The one call into health-core's classifier for one report, shared by the review and the
 * save (`labRows`): the ticked refs' rows built by `importRow`, each on its own day or `day`
 * (null: no day yet, so those wait and are not sent), against the record. Its `rows` are
 * exactly what Save submits, in order; its `values` every value's group.
 */
export function classifyReport(extraction: Extraction, file: RoadmapFile | null, ticked: Iterable<string>, day: string | null, now: string): ImportClassification {
  const result = extraction as ImportFile['result'];
  const days = valueDays(result, day);
  const rows: Record<string, BulkRow> = {};
  for (const ref of ticked) {
    const on = days[ref] ? validDay(days[ref]!, { now }) : null;
    const row = on ? importRow(result, ref, on) : null;
    if (row) rows[ref] = row;
  }
  return classifyImportValues([{ result, rows, days }], file ?? createEmptyFile({ deviceId: 'review', now }), now);
}

/** The review's groups for the ticks and test day it holds now. */
export function labReviewGroups(extraction: Extraction, file: RoadmapFile | null, ticked: readonly string[], reportDay: string, now: string): LabReviewGroups {
  const ticks = new Set(ticked);
  const day = validDay(reportDay, { now }) ?? null;
  const all = classifyReport(extraction, file, ticks, day, now).values;
  const offered = all.filter((v) => /^[va]\d+$/.test(v.ref));
  const items: GroupedItem[] = offered.map((v) => {
    if (v.group !== 'unsure') return { ref: v.ref, group: v.group };
    // Outside its range: the classifier's own dry-run refusal, as the receipt words it.
    const words = v.refusal && 'measurement' in v.refusal ? refusalWords(v.refusal) : undefined;
    const refusal = words && (words.line ?? `Not saved, ${words.label}: ${words.message}`);
    return { ref: v.ref, group: 'unsure', reasons: v.reasons, ...(v.reasons.includes('conflict') ? { conflict: IMPORT_REVIEW_TEXT.conflictKept } : null), ...(refusal ? { refusal } : null) };
  });
  const count = (group: GroupedItem['group']) => items.filter((i) => i.group === group).length;
  const writes = (i: GroupedItem) => i.group === 'sure' || (i.group === 'unsure' && !i.conflict);
  // The ticked values the save writes, in the order it submits them.
  const saveRefs = offered.filter((v) => v.sent && v.writes).map((v) => v.ref);
  const unsure = count('unsure');
  const sure = count('sure');
  const saved = count('saved');
  const groups = notSavedGroups(all);
  const extracted = notSavedGroups(all.filter((v) => !/^[va]\d+$/.test(v.ref)));
  return {
    summary: importSummaryText(importSummary([{ result: extraction as ImportFile['result'] }])),
    items,
    check: unsure ? { title: IMPORT_REVIEW_TEXT.checkTitle(unsure), footer: IMPORT_REVIEW_TEXT.checkFooter } : null,
    sure: sure ? {
      willSave: IMPORT_REVIEW_TEXT.willSave(items.filter((i) => i.group === 'sure' && ticks.has(i.ref)).length),
      showAll: IMPORT_REVIEW_TEXT.showAll(sure),
      hide: IMPORT_REVIEW_TEXT.hide,
    } : null,
    alreadySaved: saved ? IMPORT_REVIEW_TEXT.alreadySaved(saved) : null,
    notSaved: groups.total ? {
      title: IMPORT_REVIEW_TEXT.notSavedTitle(groups.total),
      lines: [...groups.lines.map((l) => l.text), ...(groups.other ? [groups.other] : [])],
      footer: IMPORT_REVIEW_TEXT.notSavedFooter,
    } : null,
    omitted: [...extracted.lines.map((l) => l.text), ...(extracted.other ? [extracted.other] : [])],
    saveRefs,
    save: items.some((i) => writes(i) || i.group === 'waiting') ? IMPORT_REVIEW_TEXT.save(saveRefs.length) : null,
  };
}
