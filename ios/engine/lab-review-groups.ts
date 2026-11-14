// The iPhone's import review groups (US-13 AC13, US-52 AC8; design:
// docs/drafts/import-review-redesign.md, series PRs 5 and 6). Which of one
// report's values need a look, which save with no row, which are already in the
// record and which are not saved, and every word the screen shows, from
// health-core's one rule (import-review.ts). Swift asks again whenever a tick or
// the test day changes, so it holds no rule and no copy of these words. The only
// call into the shared classifier is `classify` below.
import type { RoadmapFile } from '../../packages/health-core/src/roadmap-file';
import { validDay } from '../../packages/health-core/src/record-edits';
import {
  classifyImportValues, heldSlotsFromFile, importSummary, importSummaryText, notSavedGroups,
  IMPORT_REVIEW_TEXT, type ClassifiedValue, type ImportFile, type UnsureReason,
} from '../../packages/health-core/src/import-review';
import type { Extraction } from './lab-review';

/** One offered value (`v<i>` or `a<i>`, the review's item refs) and its group. */
export interface GroupedItem {
  ref: string;
  group: 'sure' | 'unsure' | 'saved' | 'notSaved';
  /** Unsure only: why it gets a row. */
  reasons?: UnsureReason[];
  /** The record already holds a different value for its day: shown, never written (Q2a). */
  conflict?: string;
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
  /** The ticked values Save sends: never one the record already holds or one it refuses. */
  saveRefs: string[];
  /** "Save {n} values", n = saveRefs' count; null when no value could be written, ticked or
   *  not (D3, nothing to save: the screen offers no Save). */
  save: string | null;
}

/** The one call into health-core's classifier for one report: its values against the record,
 *  filed on `day` when they have none of their own. `ticked`: the refs the person has ticked. */
function classify(extraction: Extraction, file: RoadmapFile | null, day: string | null, _ticked: ReadonlySet<string>): ClassifiedValue[] {
  const one: ImportFile = { result: extraction as ImportFile['result'], day };
  return classifyImportValues([one], file ? heldSlotsFromFile(file) : new Map());
}

/** The review's groups for the ticks and test day it holds now. */
export function labReviewGroups(extraction: Extraction, file: RoadmapFile | null, ticked: readonly string[], reportDay: string, now: string): LabReviewGroups {
  const ticks = new Set(ticked);
  const day = validDay(reportDay, { now }) ?? null;
  const all = classify(extraction, file, day, ticks);
  const offered = all.filter((v) => /^[va]\d+$/.test(v.ref));
  const items: GroupedItem[] = offered.map((v) => {
    if (v.group !== 'unsure') return { ref: v.ref, group: v.group };
    return { ref: v.ref, group: 'unsure', reasons: v.reasons, ...(v.reasons.includes('conflict') ? { conflict: IMPORT_REVIEW_TEXT.conflictKept } : null) };
  });
  const count = (group: GroupedItem['group']) => items.filter((i) => i.group === group).length;
  const writes = (i: GroupedItem) => i.group === 'sure' || (i.group === 'unsure' && !i.conflict);
  const saveRefs = items.filter((i) => ticks.has(i.ref) && writes(i)).map((i) => i.ref);
  const unsure = count('unsure');
  const sure = count('sure');
  const saved = count('saved');
  const groups = notSavedGroups(all);
  return {
    summary: importSummaryText(importSummary([{ result: extraction as ImportFile['result'], day }])),
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
    saveRefs,
    save: items.some(writes) ? IMPORT_REVIEW_TEXT.save(saveRefs.length) : null,
  };
}
