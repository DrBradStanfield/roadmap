/**
 * The web upload review's ledger (web list PR 1b; US-13 AC26, Brad 2026-11-21): every value a read lab report offered is a
 * row, in every state, in picked and extraction order, under the day it printed. A row never disappears; only its status
 * and caption change. Neither the set, the order nor the section reads the classification: the classification gives each
 * row only its status, caption and `saves`. Each row carries its tick, its held text and its number in every status, so no
 * choice can lose the control that holds it. `attention`: the row has reasons, an error, or anything the person entered;
 * the rest sit behind "Show all". The phone never calls this (its doors draw `uploadView`).
 */
import { IMPORT_REVIEW_TEXT, NOT_SAVED_TEXT, type NotSavedReason, type UnsureReason } from './import-review';
import { UNDATED_PREVIOUS } from './lab-extraction';
import { isCellMetric, rangeMessage, type CellUnit } from './cell-unit';
import { shownValue, typedTextError, type ShownValue } from './cell-input';
import { validDay } from './record-edits';
import type { FileLabValue, FileMeasurement, RoadmapFile } from './roadmap-file';
import type { MetricType } from './units';
import { candidates, type Candidate, type RowFault } from './upload-candidates';
import type { TypedText } from './upload-choices';
import type { UploadState } from './upload-flow';
import { readFiles, type UploadReview } from './upload-review';
import { DAY_CONTROL_TEXT, longDate, REVIEW_CELL_TEXT, UPLOAD_TEXT } from './upload-text';
import { dayKey, heldText, savesOn } from './upload-view';

/** What Save does with a row, one at a time. `error`: it blocks Save (held text, or selected with a fault). */
export type ListStatus =
  | { kind: 'saves' }
  | { kind: 'check'; reasons: UnsureReason[] }
  | { kind: 'conflict'; replacing: boolean; reasons: UnsureReason[] }
  | { kind: 'alreadyInRecord' }
  | { kind: 'copy' }
  | { kind: 'sameDay' }
  | { kind: 'notSaved'; reason: NotSavedReason }
  | { kind: 'waits' }
  | { kind: 'cleared' }
  | { kind: 'error' };

/**
 * `key`: `fileId:ref`, the key Save's blockers name. `section`: its day control's key (`dayKey`), from the day it printed.
 * `typed`: text held in its input. `shown`: its number in the person's unit. `error`: its fault's words, ticked or not.
 * `replaces`: a conflict's held row, for Replace; `held` that row's value as readers show it. `input`: whether its input
 * takes typing, the rule `choose` keeps: `none` for a core metric the units table lacks, whose number can never be written,
 * so its only control is its tick. Fixed per row, whatever its status. `reasons`: why to check it beyond its caption, as the
 * iPhone's row shows them, in any status: the extractor's question, then the guessed-unit note. Apart from `caption`, which
 * says what Save does with the row (one line, from its status), as `question` and `unitNote` sit apart from `conflict` on
 * the iPhone. `name`: its accessible name (US-13 AC10), "<test> value from <file>, <day>", the day it saves on left out
 * while none, ", another reading" on a later row of the same test there (KNOWN: a third shares the second's name).
 * `replaceLabel`: the Replace control's name with that day in words, while there is a Replace and a day.
 */
export interface ListRow {
  key: string; fileId: string; ref: string; label: string; section: string;
  status: ListStatus; caption: string | null; saves: boolean;
  ticked: boolean; typed: TypedText | null; shown: ShownValue; error: string | null; input: 'number' | 'none';
  replaces: string | null; replacing: boolean; held: string | null;
  attention: boolean; reasons: string[]; name: string; replaceLabel: string | null;
}

/** A day control, one per day source a file's values printed: the test's, the undated previous column's, or a dated
 *  previous column's (a real past day; one still to come is never saved). `chosen`: the person's pick as given; `day`: the
 *  day its values save on now, null while none. Its key names the source, never the day. `label`: its name, one for both
 *  previous columns (owner ruling 2026-11-21); a dated one also shows `printedLine`, the day it printed in words, so two
 *  of one file are told apart. `hint`: what it asks for while it has no day (an undated report says so; an undated previous
 *  column names its limits), else null. */
export type DayControl = { key: string; fileId: string; chosen: string | null; day: string | null; label: string; hint: string | null } & (
  | { source: 'test' }
  | { source: 'previous'; month: string | null; before: string | null }
  | { source: 'column'; printed: string; printedLine: string });

/** `check`: the heading over the rows with `attention`, which show before "Show all" (null when none); `showAll` counts the
 *  rest. `checkNote`: the review's footer under the heading (owner ruling 2026-11-21, no new words), exactly while a row with
 *  attention that the review is unsure of says nothing itself (no caption, reason or error: a value unsure only for its
 *  read's confidence); else null. */
export interface UploadList { rows: ListRow[]; days: DayControl[]; check: string | null; checkNote: string | null; showAll: string | null; hide: string }

const errorWords = (fault: RowFault | null, unitOf: (metric: MetricType) => CellUnit): string | null =>
  !fault ? null : fault.kind === 'typed' ? typedTextError(fault.text) : fault.kind === 'range' ? rangeMessage(fault.metric, unitOf(fault.metric), fault.fault) : fault.message;

function statusOf(c: Candidate, replacing: boolean): ListStatus {
  const { v } = c;
  if (c.blocks) return { kind: 'error' };
  if (!c.ticked) return { kind: 'cleared' };
  if (v.group === 'notSaved') return v.reason === 'sameDay' ? { kind: 'sameDay' } : { kind: 'notSaved', reason: v.reason };
  if (v.copy || ('duplicate' in v && v.duplicate)) return { kind: 'copy' };
  if (v.group === 'saved') return { kind: 'alreadyInRecord' };
  if (!v.sent || v.group === 'waiting') return { kind: 'waits' };
  if (v.group === 'unsure' && v.reasons.includes('conflict')) return { kind: 'conflict', replacing, reasons: v.reasons };
  return v.group === 'unsure' ? { kind: 'check', reasons: v.reasons } : { kind: 'saves' };
}

function captionOf(status: ListStatus, error: string | null): string | null {
  switch (status.kind) {
    case 'error': return error;
    case 'sameDay': case 'copy': return NOT_SAVED_TEXT.sameDay;
    case 'notSaved': return NOT_SAVED_TEXT[status.reason];
    case 'alreadyInRecord': return REVIEW_CELL_TEXT.alreadyInRecord;
    case 'waits': return UPLOAD_TEXT.chooseDay;
    case 'conflict': return status.replacing ? UPLOAD_TEXT.replaces : IMPORT_REVIEW_TEXT.conflictKept;
    // A lab the write refuses, which blocks nothing, says why in the write's words.
    default: return error;
  }
}

/** A value's day source, from the day it printed alone. */
const sourceOf = (printed: string | undefined): Parameters<typeof dayKey>[1] =>
  printed === undefined ? 'test' : printed === UNDATED_PREVIOUS ? 'previous' : `printed:${printed}`;

/**
 * `review`: the caller's `uploadReview`, the one it hands `uploadView` and `uploadSavePlan`. `unitOf`: the unit the person
 * reads each core value in. Rows the press promised alone save while saving (`reviewed`), as `uploadView` draws them.
 */
export function uploadList(s: UploadState, record: RoadmapFile, now: string, review: UploadReview, unitOf: (metric: MetricType) => CellUnit): UploadList {
  const reads = new Map(readFiles(s).map((f) => [f.id, f.status]));
  const promised = s.phase === 'saving' && s.reviewed ? new Set(s.reviewed.map((v) => `${v.file}:${v.ref}`)) : null;
  const rowsById = new Map<string, FileMeasurement | FileLabValue>(review.held.size ? [...record.measurements, ...record.labValues].map((r) => [r.id, r]) : []);
  const days = new Map<string, DayControl>();
  const named = new Set<string>();
  let unworded = false;
  const rows = candidates(review, s).map((c): ListRow => {
    const lab = review.labFiles[c.file];
    const choices = reads.get(c.fileId)!.choices;
    const printed = c.at.value.recordedAt;
    const section = dayKey(c.fileId, sourceOf(printed));
    if (!days.has(section)) {
      const day = lab.days[c.ref]?.slice(0, 10) ?? null;
      const control = { key: section, fileId: c.fileId, day };
      const before = lab.day?.slice(0, 10) ?? null;
      if (printed === undefined) days.set(section, { ...control, source: 'test', chosen: choices.testDay, label: UPLOAD_TEXT.dayOfTest, hint: day ? null : UPLOAD_TEXT.undatedTitle });
      else if (printed === UNDATED_PREVIOUS) days.set(section, { ...control, source: 'previous', chosen: choices.previousDay, month: lab.previousMonth, before, label: DAY_CONTROL_TEXT.previous, hint: day ? null : DAY_CONTROL_TEXT.pickDay(lab.previousMonth, before) });
      else if (validDay(printed, { now })) days.set(section, { ...control, source: 'column', printed, chosen: choices.columnDays?.[printed] ?? null, printedLine: longDate(printed) ?? printed, label: DAY_CONTROL_TEXT.previous, hint: null });
    }
    const replacing = !c.v.copy && lab.replacing.includes(c.ref);
    const status = statusOf(c, replacing);
    const error = errorWords(c.fault, unitOf);
    const replaces = c.v.copy ? null : review.held.get(`${c.file}:${c.ref}`) ?? null;
    const on = savesOn(lab.days[c.ref], lab.day, now);
    const dayLine = on && (longDate(on) ?? on);
    const from = [lab.name, dayLine].filter(Boolean).join(', ');
    const again = named.has(`${c.v.label}\n${from}`);
    named.add(`${c.v.label}\n${from}`);
    const touched = choices.ticks[c.ref] !== undefined || c.edit !== undefined || c.typed !== null || choices.replace[c.ref] !== undefined;
    const row: ListRow = {
      key: `${c.fileId}:${c.ref}`, fileId: c.fileId, ref: c.ref, label: c.v.label, section, status, caption: captionOf(status, error),
      saves: c.v.sent && c.v.writes && (!promised || promised.has(`${c.fileId}:${c.ref}`)),
      ticked: c.ticked, typed: c.typed, input: c.at.kind === 'core' && !isCellMetric(c.at.value.metric) ? 'none' : 'number',
      shown: shownValue(c.at, c.edit, c.at.kind === 'core' && isCellMetric(c.at.value.metric) ? unitOf(c.at.value.metric) : 'si', choices.editUnits?.[c.ref]), error,
      replaces, replacing, held: heldText(replaces ? rowsById.get(replaces) : undefined, record),
      attention: (c.v.group === 'unsure' && c.v.reasons.length > 0) || error !== null || touched,
      reasons: [c.at.value.question, c.at.kind === 'core' && c.at.value.unitGuessed ? REVIEW_CELL_TEXT.checkUnit : null].filter((w): w is string => !!w),
      name: REVIEW_CELL_TEXT.rowName(c.v.label, from, again),
      replaceLabel: replaces && dayLine ? REVIEW_CELL_TEXT.replaceLabel(c.v.label, dayLine) : null,
    };
    if (row.attention && c.v.group === 'unsure' && !row.caption && !row.reasons.length && !row.error) unworded = true;
    return row;
  });
  const loud = rows.filter((r) => r.attention).length;
  const quiet = rows.length - loud;
  return { rows, days: [...days.values()], check: loud ? IMPORT_REVIEW_TEXT.checkTitle(loud) : null,
    checkNote: unworded ? IMPORT_REVIEW_TEXT.checkFooter : null, showAll: quiet ? IMPORT_REVIEW_TEXT.showAll(quiet) : null, hide: IMPORT_REVIEW_TEXT.hide };
}
