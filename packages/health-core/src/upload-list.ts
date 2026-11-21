/**
 * The web upload review's ledger (web list PR 1b; US-13 AC26, Brad 2026-11-21): every value a read lab report offered is a
 * row, in every state, in picked and extraction order, under the day it printed. A row never disappears; only its status
 * and caption change. Neither the set, the order nor the section reads the classification: the classification gives each
 * row only its status, caption and `saves`. Each row carries its tick, its held text and its number in every status, so no
 * choice can lose the control that holds it. `attention`: the row has reasons, an error, or anything the person entered;
 * the rest sit behind "Show all". The phone never calls this (its doors draw `uploadView`).
 */
import { IMPORT_REVIEW_TEXT, NOT_SAVED_TEXT, type NotSavedReason, type OfferedValue, type UnsureReason } from './import-review';
import { UNDATED_PREVIOUS } from './lab-extraction';
import { cellLabel, isCellMetric, isLpaUnit, rangeMessage, recordLpaUnit, type CellUnit } from './cell-unit';
import { printedNote, shownValue, typedTextError, type ShownValue } from './cell-input';
import { DAY_NOT_HAPPENED } from './lab-series';
import { validDay } from './record-edits';
import type { FileLabValue, FileMeasurement, RoadmapFile } from './roadmap-file';
import { hasUnitChoice, LPA_UNITS, type LpaUnit, type MetricType, type UnitSystem } from './units';
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
 * `replaceLabel`: the Replace control's name with that day in words, while there is a Replace and a day. `unit`: its
 * unit control (`RowUnit`). `printed`: what the report printed, while the row shows another number or a guessed unit
 * (`printedNote`, the grid's "Printed:" line, US-13 AC11), from the value as read in the person's unit, an edit or not.
 */
export interface ListRow {
  key: string; fileId: string; ref: string; label: string; section: string;
  status: ListStatus; caption: string | null; saves: boolean;
  ticked: boolean; typed: TypedText | null; shown: ShownValue; error: string | null; input: 'number' | 'none';
  replaces: string | null; replacing: boolean; held: string | null;
  attention: boolean; reasons: string[]; name: string; replaceLabel: string | null; unit: RowUnit; printed: string | null;
}

/**
 * A row's unit, as the grid's unit chip and Lp(a) control draw it (ReviewMatrix.tsx, US-05 AC2), so the screen knows no
 * unit itself. The person's choice lives in the web (hooks/useUnits.ts per-field overrides, lib/lpa-unit.ts the record's
 * Lp(a) unit); the engine reads it only through `unitOf`. `label`: the unit beside the input: held text's own unit, the one
 * it was typed in (`typed.unit`, US-13 AC5), else the unit its number shows in. `typeIn`: the unit a commit from the row is
 * typed in (`ChoiceChange` typed `unit`), the same one, so the label never names a unit the text is not read in; null for
 * a lab or a core metric the units table lacks, which take none. `toggle`: the unit one press of its chip shows the test in,
 * the other of its two from the one the person reads (`unitOf`); null where the unit is fixed (mmHg, PSA), for Lp(a), a lab
 * or an unknown metric. `choices`: Lp(a)'s three units, the one shown being `shown.cell.unit`; null for any other row. While
 * the row holds text, neither: the person fixes or clears the text first, since a toggle would change nothing on that row
 * (owner ruling on PR 1951); other rows of the test keep theirs. `current`: on an Lp(a) row, the one of its three units the
 * person reads it in (the one `choices` marks, and the unit `shown` is in): `unitOf`'s answer, or for a system the unit the
 * web's rule gives it (lib/lpa-unit.ts `effectiveLpaUnit`, through health-core `recordLpaUnit`: US units mg/dL, else
 * nmol/L); null on any other row.
 */
export interface RowUnit { label: string; typeIn: CellUnit | null; toggle: CellUnit | null; choices: readonly LpaUnit[] | null; current: LpaUnit | null }

function rowUnit(at: OfferedValue, typed: TypedText | null, shown: ShownValue, unitOf: (metric: MetricType) => CellUnit): RowUnit {
  if (at.kind !== 'core' || !isCellMetric(at.value.metric)) return { label: shown.unit, typeIn: null, toggle: null, choices: null, current: null };
  const metric = at.value.metric;
  const reads = unitOf(metric);
  const typeIn = typed?.unit ?? reads;
  return {
    label: cellLabel(metric, typeIn), typeIn,
    toggle: !typed && metric !== 'lpa' && hasUnitChoice(metric) ? (reads === 'si' ? 'conventional' : 'si') : null,
    choices: !typed && metric === 'lpa' ? LPA_UNITS : null,
    current: metric !== 'lpa' ? null : isLpaUnit(reads) ? reads : recordLpaUnit(undefined, reads as UnitSystem),
  };
}

/** A day control, one per day source a file's values printed: the test's, the undated previous column's, or a dated
 *  previous column's (a real past day; one still to come is never saved). `chosen`: the person's pick as given; `day`: the
 *  day its values save on now, null while none. Its key names the source, never the day. `label`: its name, one for both
 *  previous columns (owner ruling 2026-11-21); a dated one also shows `printedLine`, the day it printed in words, so two
 *  of one file are told apart. `picker`: the day its picker shows (YYYY-MM-DD): its day, else a pick that waits, else null,
 *  empty (a pick that is no calendar day shows nothing). `hint`: the words beside it while it has no day: with no pick, what
 *  it asks for (an undated report says so; an undated previous column names its limits); with a pick that waits, why: a day
 *  still to come has not happened (`DAY_NOT_HAPPENED`, the web's words for a test moved to one), any other the control's
 *  limits (`DAY_CONTROL_TEXT.pickDay`: a previous column's day comes before the test's); else null. `fileName`: its file
 *  as rows name it (`uploadFileName`, a ZIP member by its path).
 *  `name`: its accessible name, ready-made: its label, the printed day when it has one, its file's name (KNOWN: two files
 *  of one name share it). `pickerLine`: what its button shows: `picker` in words, else the grid's empty day ("—"). */
export type DayControl = { key: string; fileId: string; chosen: string | null; day: string | null; picker: string | null; pickerLine: string; label: string; hint: string | null; fileName: string; name: string } & (
  | { source: 'test' }
  | { source: 'previous'; month: string | null; before: string | null }
  | { source: 'column'; printed: string; printedLine: string });

/** The rows with `attention` show before "Show all"; `showAll` counts the rest. `check`: the heading over them, counting only
 *  the rows that need checking (a reason the person can act on, the review unsure of it, an error or held text), never a
 *  row whose only claim is that the person touched it; null when none needs checking. `checkNote`: the review's footer under the heading (owner ruling 2026-11-21, no new words), exactly while a row with
 *  attention that the review is unsure of says nothing itself (no caption, reason or error: a value unsure only for its
 *  read's confidence); else null. */
export interface UploadList { rows: ListRow[]; days: DayControl[]; check: string | null; checkNote: string | null; showAll: string | null; hide: string }

/** A not-saved reason no change of the person's lifts: the value's unit, no unit, a urine unit, unreadable, or its own day
 *  still to come. A row with one, or one already in the record, keeps its reasons but needs no attention for them. */
const UNLIFTABLE: readonly NotSavedReason[] = ['unit', 'noUnit', 'urine', 'unreadable', 'futureDay', 'futureCoreDay'];
const actionable = (status: ListStatus) => status.kind !== 'alreadyInRecord' && !(status.kind === 'notSaved' && UNLIFTABLE.includes(status.reason));

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

/** A day control's picker and words (`DayControl`), from its pick and its day. `asks`: its words with no pick; `limits` its
 *  limits' words; `printed`: the report's own day, for the test's control. A pick, or with none the printed day, read as a
 *  calendar day, to come or not: one still to come has not happened (web list PR 1e review, H2: a report printed on a day
 *  to come said "This report has no date"; the iPhone's page still does, KNOWN phoneFutureReportDate). */
function pickerOf(chosen: string | null, day: string | null, now: string, asks: string | null, limits: string, printed: string | null = null) {
  const shown = (picker: string | null, hint: string | null) => ({ picker, pickerLine: picker ? longDate(picker) ?? picker : DAY_CONTROL_TEXT.noDay, hint });
  if (day) return shown(day, null);
  const calendar = validDay(chosen ?? printed, { now, latestDay: '9999-12-31' });
  const ahead = !!calendar && !validDay(calendar, { now });
  if (chosen === null) return ahead ? shown(calendar, DAY_NOT_HAPPENED) : shown(null, asks);
  return shown(calendar, ahead ? DAY_NOT_HAPPENED : limits);
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
  let checks = 0;
  const rows = candidates(review, s).map((c): ListRow => {
    const lab = review.labFiles[c.file];
    const choices = reads.get(c.fileId)!.choices;
    const printed = c.at.value.recordedAt;
    const section = dayKey(c.fileId, sourceOf(printed));
    if (!days.has(section)) {
      const day = lab.days[c.ref]?.slice(0, 10) ?? null;
      const control = (label: string, printedLine?: string) => ({ key: section, fileId: c.fileId, day, label, fileName: lab.name, name: [label, printedLine, lab.name].filter(Boolean).join(', ') });
      const before = lab.day?.slice(0, 10) ?? null;
      if (printed === undefined) days.set(section, { ...control(UPLOAD_TEXT.dayOfTest), source: 'test', chosen: choices.testDay, ...pickerOf(choices.testDay, day, now, UPLOAD_TEXT.undatedTitle, DAY_CONTROL_TEXT.pickDay(null, null), reads.get(c.fileId)!.extraction.reportDate ?? null) });
      else if (printed === UNDATED_PREVIOUS) {
        const limits = DAY_CONTROL_TEXT.pickDay(lab.previousMonth, before);
        days.set(section, { ...control(DAY_CONTROL_TEXT.previous), source: 'previous', chosen: choices.previousDay, month: lab.previousMonth, before, ...pickerOf(choices.previousDay, day, now, limits, limits) });
      } else if (validDay(printed, { now })) {
        const printedLine = longDate(printed) ?? printed;
        const chosen = choices.columnDays?.[printed] ?? null;
        days.set(section, { ...control(DAY_CONTROL_TEXT.previous, printedLine), source: 'column', printed, chosen, printedLine, ...pickerOf(chosen, day, now, null, DAY_CONTROL_TEXT.pickDay(null, before)) });
      }
    }
    const replacing = !c.v.copy && lab.replacing.includes(c.ref);
    const status = statusOf(c, replacing);
    const shown = shownValue(c.at, c.edit, c.at.kind === 'core' && isCellMetric(c.at.value.metric) ? unitOf(c.at.value.metric) : 'si', choices.editUnits?.[c.ref]);
    const error = errorWords(c.fault, unitOf);
    const replaces = c.v.copy ? null : review.held.get(`${c.file}:${c.ref}`) ?? null;
    const on = savesOn(lab.days[c.ref], lab.day, now);
    const dayLine = on && (longDate(on) ?? on);
    const from = [lab.name, dayLine].filter(Boolean).join(', ');
    const again = named.has(`${c.v.label}\n${from}`);
    named.add(`${c.v.label}\n${from}`);
    const touched = choices.ticks[c.ref] !== undefined || c.edit !== undefined || c.typed !== null || choices.replace[c.ref] !== undefined;
    const reasons = [c.at.value.question, c.at.kind === 'core' && c.at.value.unitGuessed ? REVIEW_CELL_TEXT.checkUnit : null].filter((w): w is string => !!w);
    const check = (c.v.group === 'unsure' && c.v.reasons.length > 0) || (reasons.length > 0 && actionable(status)) || error !== null;
    if (check) checks++;
    const row: ListRow = {
      key: `${c.fileId}:${c.ref}`, fileId: c.fileId, ref: c.ref, label: c.v.label, section, status, caption: captionOf(status, error),
      saves: c.v.sent && c.v.writes && (!promised || promised.has(`${c.fileId}:${c.ref}`)),
      ticked: c.ticked, typed: c.typed, input: c.at.kind === 'core' && !isCellMetric(c.at.value.metric) ? 'none' : 'number',
      shown, error,
      replaces, replacing, held: heldText(replaces ? rowsById.get(replaces) : undefined, record),
      attention: check || touched, reasons,
      name: REVIEW_CELL_TEXT.rowName(c.v.label, from, again),
      replaceLabel: replaces && dayLine ? REVIEW_CELL_TEXT.replaceLabel(c.v.label, dayLine) : null,
      unit: rowUnit(c.at, c.typed, shown, unitOf),
      printed: c.at.kind === 'core' ? printedNote(c.at.value, isCellMetric(c.at.value.metric) ? unitOf(c.at.value.metric) : 'si') : null,
    };
    if (row.attention && c.v.group === 'unsure' && !row.caption && !row.reasons.length && !row.error) unworded = true;
    return row;
  });
  const loud = rows.filter((r) => r.attention).length;
  const quiet = rows.length - loud;
  return { rows, days: [...days.values()], check: checks ? IMPORT_REVIEW_TEXT.checkTitle(checks) : null,
    checkNote: unworded ? IMPORT_REVIEW_TEXT.checkFooter : null, showAll: quiet ? IMPORT_REVIEW_TEXT.showAll(quiet) : null, hide: IMPORT_REVIEW_TEXT.hide };
}
