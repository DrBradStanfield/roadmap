// The web upload ledger's properties (web list PR 1b), for upload-view.property.test.ts. Not shipped: only tests import it.
// Each oracle reads the extraction, the choices, the units table and (for a kept conflict or a refused blood pressure
// pair) the review, never what `uploadList` computed. The mutation each was shown failing on is named beside it.
import { commaQuestion } from './parseNumber';
import { cellRange, rangeMessage, type CellUnit } from './cell-unit';
import { ENTER_A_NUMBER, NUMERIC_SYNTAX_GUIDANCE, typedCommit } from './cell-input';
import { IMPORT_REVIEW_TEXT, offeredValues, type ClassifiedValue, type OfferedValue } from './import-review';
import { UNDATED_PREVIOUS } from './lab-extraction';
import { validDay } from './record-edits';
import { rangeFault, UNIT_DEFS, type MetricType } from './units';
import { choose, type ChoiceChange, type TypedText } from './upload-choices';
import { uploadFileName, type UploadState } from './upload-flow';
import type { UploadList } from './upload-list';
import type { UploadReview } from './upload-review';
import { DAY_CONTROL_TEXT, longDate, REVIEW_CELL_TEXT } from './upload-text';
import type { UploadView } from './upload-view';

type Fail = (prop: string, msg: string) => never;
/** What the person entered in each row, by `fileId:ref`, as the harness logged it from their own events (L7 keeps it). */
export type PersonInputs = ReadonlyMap<string, { typed: TypedText | null; edit: number | undefined; editUnit?: CellUnit }>;
/** A core metric the units table holds; an unfamiliar one has no range and no unit. */
const known = (metric: string): metric is MetricType => Object.prototype.hasOwnProperty.call(UNIT_DEFS, metric);
type Read = Extract<Extract<UploadState, { files: unknown }>['files'][number]['status'], { s: 'read' }>;

/** Each read lab report's state, in the review's order (picked order). */
const labReads = (s: UploadState, review: UploadReview) => review.labFiles.map((lf, i) => {
  const f = ('files' in s ? s.files : []).find((x) => x.id === lf.fileId)!;
  return { lf, i, st: f.status as Read };
});

/** A value's section, from the day it printed alone. */
const sectionOf = (fileId: string, printed: string | undefined) =>
  `${fileId}|${printed === undefined ? 'test' : printed === UNDATED_PREVIOUS ? 'previous' : `printed:${printed}`}`;

/**
 * L1 existence. In every state the list's row keys are the refs `offeredValues` gives each read lab report, once each, in
 * picked then extraction order, each under the section its printed day names. Mutation: rows only for values not
 * classified `saved` (`candidates(...).filter((c) => c.v.group !== 'saved')`) fails it on the first held equal value.
 */
export function checkExistence(s: UploadState, review: UploadReview, list: UploadList, fail: Fail) {
  const want = labReads(s, review).flatMap(({ lf, st }) => offeredValues(st.extraction).map(({ ref, value }) => `${lf.fileId}:${ref} ${sectionOf(lf.fileId, value.recordedAt)}`));
  const got = list.rows.map((r) => `${r.key} ${r.section}`);
  if (JSON.stringify(got) !== JSON.stringify(want)) fail('L1', `rows ${JSON.stringify(got)}, offered ${JSON.stringify(want)}`);
}

/**
 * L2 input shown. Ticked is `ticks[ref] ?? true`; the held text and the edit are what the person's own events left
 * (`inputs`, the harness's log, never the choices after the engine touched them); the number is that edit else the one
 * read. Mutation: `ticked: c.v.sent` (a waiting value drawn unticked) fails it.
 */
export function checkInputs(s: UploadState, review: UploadReview, list: UploadList, inputs: PersonInputs, fail: Fail) {
  const byKey = new Map(list.rows.map((r) => [r.key, r]));
  for (const { lf, st } of labReads(s, review)) {
    for (const at of offeredValues(st.extraction)) {
      const row = byKey.get(`${lf.fileId}:${at.ref}`);
      if (!row) continue; // L1's
      const ticked = st.choices.ticks[at.ref] ?? true;
      const entered = inputs.get(`${lf.fileId}:${at.ref}`);
      const typed = entered?.typed ?? null;
      const current = entered?.edit ?? (at.kind === 'core' ? at.value.valueSI : at.value.value);
      if (row.ticked !== ticked || JSON.stringify(row.typed) !== JSON.stringify(typed) || row.shown.current !== current) {
        fail('L2', `${row.key} shows ticked ${row.ticked}, typed ${JSON.stringify(row.typed)}, ${row.shown.current}; chose ${ticked}, ${JSON.stringify(typed)}, ${current}`);
      }
    }
  }
}

/** Held text anywhere in the pick. */
export const holdsText = (s: UploadState) => ('files' in s ? s.files : []).some((f) => f.status.s === 'read' && Object.keys(f.status.choices.typed ?? {}).length > 0);

/**
 * L3 typed blocks. Any text the person's own events left held (`inputs`) means Save is off and a blocker sits at that
 * row (the run checks `uploadSave` refuses too). Mutation: the typed blocker read only for sent values
 * (`c.typed && c.v.sent`) fails it on text held in a report waiting for its day.
 */
export function checkTypedBlocks(s: UploadState, view: UploadView, inputs: PersonInputs, fail: Fail) {
  if (s.phase !== 'open' && s.phase !== 'saveFailed') return;
  const at = new Set(view.save.blockers.map((b) => b.at));
  for (const [key, { typed }] of inputs) {
    if (!typed) continue;
    if (view.save.enabled) fail('L3', `Save on while ${key} holds text`);
    if (!at.has(key)) fail('L3', `no blocker at ${key}, which holds text`);
  }
}

/** `editUnit`: the unit the edit was typed in (web only, owner ruling on PR 1949); it goes and comes with the edit. */
type Entered = { typed: TypedText | null; edit: number | undefined; editUnit?: CellUnit };

/**
 * What one of the person's own changes leaves in the row it names, from the change alone (US-13 AC5, AC12, AC21, AC26):
 * - tick on, Replace on or off, a day: text and edit kept;
 * - tick off: the text goes, the edit stays (upload-choices.ts `untick` never touches `edits`, as on main; AC26: "an
 *   emptied input clears the row and drops the text", and only the person's own clear drops it);
 * - an emptied input: the same as tick off;
 * - a number (an `edit`, or typed text that reads as one): the edit is that number, the text goes; an `edit` of null or
 *   no finite number drops the edit; typed text that is the shown number again keeps the edit as it was (US-03 AC3);
 * - text that is no number: held, and the edit beneath it stays (`choose` builds the held text on top of the choices with
 *   their `edits`), so clearing the text shows the edit again;
 * - refused, nothing changes: an `edit` or `typed` on a core metric the units table lacks (an emptied input too), `typed`
 *   on a letter's value, a unit that does not fit the value.
 * The number typed text reads as comes from the cells' own rule (`typedCommit`), never from `choose`.
 */
export function expectedInput(change: ChoiceChange, at: OfferedValue, lab: boolean, was: Entered): Entered {
  const unknownCore = at.kind === 'core' && !known(at.value.metric);
  const kept = { edit: was.edit, editUnit: was.editUnit };
  if ('tick' in change) return change.on ? was : { typed: null, ...kept };
  // A plain edit (the phone's kind) carries no unit, so the unit typed goes.
  if ('edit' in change) return unknownCore ? was : { typed: null, edit: change.value === null || !Number.isFinite(change.value) ? undefined : change.value, editUnit: undefined };
  if (!('typed' in change)) return was;
  if (unknownCore || !lab) return was;
  if (!change.text.trim()) return { typed: null, ...kept };
  const commit = typedCommit(change.text, at, was.edit, change.unit, was.editUnit);
  if (!commit) return was;
  if (commit.kind === 'hold') return { typed: { text: change.text, unit: change.unit }, ...kept };
  // A number typed is an edit in the unit typed (a core value's; a lab's has none).
  return commit.kind === 'edit' ? { typed: null, edit: commit.value, editUnit: change.unit ?? undefined } : { typed: null, ...kept };
}

/** The ref a change names, if any. */
const refOf = (c: ChoiceChange): string | null => ('tick' in c ? c.tick : 'replace' in c ? c.replace : 'edit' in c ? c.edit : 'typed' in c ? c.typed : null);

/**
 * L7 input kept. The harness logs each row's held text and edit from the person's own events alone: the expected effect of
 * each change (`expectedInput`), applied when the machine takes a choice at all (open or after a failed Save, on a read
 * file). Every other step (door steps, record changes, reads landing, Save and its outcome) and every other row keeps
 * them. The engine's state must match the log after every step. Mutations: `replacesLost` reducing with the person's clear
 * (held text erased by a lost Replace) fails it; a tick on that erases held text (upload-choices.ts `choose`,
 * `change.on ? unheld({ ...c, ticks: ... }, change.tick)`) fails it. It logs the unit each edit was typed in too (web
 * list PR 1d): a typed commit that sets no unit (`editUnit(kept, change.typed, null)`) fails it ("f2:v1 holds
 * {"typed":null,"edit":500}, the person's events left {...,"editUnit":"si"}"); a plain edit that keeps the unit fails it.
 */
export function keepInputs(s: UploadState, inputs: Map<string, Entered>, chose: { id: string; change: ChoiceChange; taken: boolean } | null, fail: Fail) {
  if (!('files' in s)) { inputs.clear(); return; }
  const named = chose?.taken ? refOf(chose.change) : null;
  for (const f of s.files) {
    if (f.status.s !== 'read') continue;
    const lab = f.status.extraction.classification === 'lab_report';
    for (const at of offeredValues(f.status.extraction)) {
      const key = `${f.id}:${at.ref}`;
      const was = inputs.get(key) ?? { typed: null, edit: undefined, editUnit: undefined };
      const want = chose && named === at.ref && chose.id === f.id ? expectedInput(chose.change, at, lab, was) : was;
      const now = { typed: f.status.choices.typed?.[at.ref] ?? null, edit: f.status.choices.edits[at.ref], editUnit: f.status.choices.editUnits?.[at.ref] };
      if (JSON.stringify(want) !== JSON.stringify(now)) fail('L7', `${key} holds ${JSON.stringify(now)}, the person's events left ${JSON.stringify(want)}`);
      inputs.set(key, want);
    }
  }
}

/** A text the row does not hold already, so a held text always changes the choices. */
const freshText = (held: TypedText | undefined) => (held?.text === 'abc' ? 'abd' : 'abc');

/**
 * L8 input kind. Every row says whether its input takes typing (`input`), and the engine agrees: a schema-valid typed
 * change addressed to the row (text that is no number, in the unit that fits it: SI for a core value, none for a lab)
 * changes its file's choices (`choose`) exactly when the row says `number`. A row that says `none` holds no text and no
 * edit. Mutations: `input: shown.cell ? 'number' : 'none'` fails it on the first plain lab; `input: 'number'` fails it on
 * the first core metric the units table lacks.
 */
export function checkInputKind(s: UploadState, review: UploadReview, list: UploadList, now: string, fail: Fail) {
  const byKey = new Map(list.rows.map((r) => [r.key, r]));
  for (const { lf, st } of labReads(s, review)) {
    for (const at of offeredValues(st.extraction)) {
      const row = byKey.get(`${lf.fileId}:${at.ref}`);
      if (!row) continue; // L1's
      const change: ChoiceChange = { typed: at.ref, text: freshText(st.choices.typed?.[at.ref]), unit: at.kind === 'core' ? 'si' : null };
      const after = choose(st.choices, change, now, st.extraction);
      const takes = after !== null && JSON.stringify(after) !== JSON.stringify(st.choices);
      if ((row.input === 'number') !== takes) fail('L8', `${row.key} says input ${row.input}; a typed change ${takes ? 'changes' : 'leaves'} its choices`);
      if (row.input === 'none' && (st.choices.typed?.[at.ref] !== undefined || st.choices.edits[at.ref] !== undefined)) fail('L8', `${row.key} takes no input but holds some`);
    }
  }
}

/** A conflict kept (not replacing), or a value never saved (its own day to come): not selected (US-13 AC5). */
const unselected = (review: UploadReview, v: ClassifiedValue) =>
  (v.group === 'unsure' && v.reasons.includes('conflict') && (!!v.copy || !review.labFiles[v.file].replacing.includes(v.ref)))
  || (v.group === 'notSaved' && (v.reason === 'futureDay' || v.reason === 'futureCoreDay'));

/**
 * L4 one quantity. For every row, sent or not, dated or not: the fault is the held text, else `rangeFault` of the candidate
 * (`edits[ref]` else the read SI number) in the units table, else the review's refusal of a sent value its own number does
 * not show (a blood pressure half, a lab filed as a core value). The error is non-null exactly then; a range error is `rangeMessage` in the person's unit; held text
 * reads the cells' guidance. A blocker sits at the row exactly when it holds text; a ticked, selected, faulty core value
 * is `refused` and blocks nothing (US-13 AC27). Mutation: the old whole-review block (`blocks = !!typed || refused`)
 * fails it on the first out-of-range read.
 * Mutation: the unsent preview built without the edit (D3) fails it on an out-of-range value corrected while its report
 * waits; `rangeMessage(metric, 'si', ...)` fails it on the first conventional seed.
 */
export function checkOneQuantity(s: UploadState, review: UploadReview, view: UploadView, list: UploadList, unitOf: (m: MetricType) => CellUnit, fail: Fail) {
  const classified = new Map(review.classification.values.map((v) => [`${v.file}:${v.ref}`, v]));
  const byKey = new Map(list.rows.map((r) => [r.key, r]));
  const open = s.phase === 'open' || s.phase === 'saveFailed';
  const blocked = new Set(view.save.blockers.map((b) => b.at));
  for (const { lf, i, st } of labReads(s, review)) {
    for (const at of offeredValues(st.extraction)) {
      const key = `${lf.fileId}:${at.ref}`;
      const row = byKey.get(key);
      const v = classified.get(`${i}:${at.ref}`);
      if (!row || !v) continue;
      const typed = st.choices.typed?.[at.ref];
      const metric = at.kind === 'core' && known(at.value.metric) ? at.value.metric : null;
      const candidate = st.choices.edits[at.ref] ?? (at.kind === 'core' ? at.value.valueSI : at.value.value);
      const range = !typed && metric ? rangeFault(cellRange(metric, 'si'), candidate) : null;
      // The carve-out: a sent value the write refuses that its own number does not show (a pressure pair, a lab filed as a core value).
      const pair = !typed && !range && v.sent && !v.writes && v.group === 'unsure' && v.reasons.includes('outOfRange');
      const fault = !!typed || !!range || pair;
      if ((row.error !== null) !== fault) fail('L4', `${key} error ${JSON.stringify(row.error)}, fault ${fault} (candidate ${candidate}${typed ? `, held "${typed.text}"` : ''})`);
      if (range && row.error !== rangeMessage(metric!, unitOf(metric!), range)) fail('L4', `${key} says ${row.error}, not the range in ${unitOf(metric!)}`);
      if (typed && ![NUMERIC_SYNTAX_GUIDANCE, ENTER_A_NUMBER, commaQuestion(typed.text.trim())].includes(row.error)) fail('L4', `${key} holds "${typed.text}" and says ${row.error}`);
      const ticked = st.choices.ticks[at.ref] ?? true;
      const blocks = !!typed;
      const refused = !typed && ticked && fault && !unselected(review, v) && at.kind === 'core';
      if (open && blocked.has(key) !== blocks) fail('L4', `${key} blocker ${blocked.has(key)}, expected ${blocks} (status ${row.status.kind})`);
      if ((row.status.kind === 'error') !== blocks) fail('L4', `${key} status ${row.status.kind}, blocks ${blocks}`);
      if ((row.status.kind === 'refused') !== refused) fail('L4', `${key} status ${row.status.kind}, refused ${refused}`);
    }
  }
}

/**
 * L5 no silent non-write. Open, the rows that save are the review's written values exactly, held text included in the
 * count; every ticked row that does not save says why. Mutation: `saves: c.v.sent` (no `writes`) fails it on the first
 * held equal value; `caption: null` for `waits` fails it on the first undated report.
 */
export function checkNoSilentNonWrite(s: UploadState, review: UploadReview, list: UploadList, fail: Fail) {
  if (s.phase !== 'open' && s.phase !== 'saveFailed') return;
  const written = review.classification.values.filter((v) => v.sent && v.writes).map((v) => `${review.labFiles[v.file].fileId}:${v.ref}`).sort();
  const saves = list.rows.filter((r) => r.saves).map((r) => r.key).sort();
  if (JSON.stringify(saves) !== JSON.stringify(written)) fail('L5', `rows that save ${JSON.stringify(saves)}, written ${JSON.stringify(written)}`);
  if (written.length !== review.classification.rows.length) fail('L5', 'written values != rows');
  for (const r of list.rows) if (r.ticked && !r.saves && !r.caption) fail('L5', `${r.key} is ticked, saves nothing and says nothing (${r.status.kind})`);
}

/** L1 again: a choice never moves, adds or drops a row. */
export function checkKeysKept(before: UploadList, after: UploadList, fail: Fail) {
  const keys = (l: UploadList) => l.rows.map((r) => `${r.key} ${r.section}`).join(',');
  if (keys(before) !== keys(after)) fail('L1', `a choice changed the rows: ${keys(before)} -> ${keys(after)}`);
}

/** What the person entered in a row, read from the choices alone: a tick set, Replace chosen, an edit, held text. */
const entered = (st: Read, ref: string) => st.choices.ticks[ref] !== undefined || st.choices.replace[ref] !== undefined
  || st.choices.edits[ref] !== undefined || st.choices.typed?.[ref] !== undefined;

/** Not-saved reasons no change of the person's lifts (owner ruling on PR 1949 review, G1). */
const UNLIFTABLE = ['unit', 'noUnit', 'urine', 'unreadable', 'futureDay', 'futureCoreDay'];

/**
 * Whether a row needs checking, from the extraction, the choices and the review alone: the review is unsure of it for a
 * reason; it has a reason in the read (a question, a guessed unit) and the person can still act on it for this Save, that
 * is unless, ticked, it is held already (equal, no copy) or not saved for a reason no change lifts; or it has an error (its
 * fault, which L4 checks from the candidate). A row only touched does not.
 */
function needsCheck(st: Read, at: OfferedValue, v: ClassifiedValue, error: string | null): boolean {
  const read = !!at.value.question || (at.kind === 'core' && !!at.value.unitGuessed);
  const ticked = st.choices.ticks[at.ref] ?? true;
  const fixed = ticked && ((v.group === 'saved' && !v.copy && !('duplicate' in v && v.duplicate)) || (v.group === 'notSaved' && UNLIFTABLE.includes(v.reason)));
  return (v.group === 'unsure' && v.reasons.length > 0) || (read && !fixed) || error !== null;
}

/**
 * L9 why (web list PR 1d). Each row's `reasons` are the extraction's own: its question, then the guessed-unit note
 * (`REVIEW_CELL_TEXT.checkUnit`). A row needs attention exactly when it needs checking (`needsCheck`) or the person entered
 * something in it (read from the choices); and every such row says why: a caption, a reason,
 * an error, or what the person entered, or the group carries its note (`checkNote`, the review's footer), which it does
 * exactly while a row with attention the review is unsure of says nothing itself (confidenceUnworded, closed by owner
 * ruling 2026-11-21). Mutations: `reasons: []` fails it on the first question; `attention` without `touched` fails it on
 * the first cleared tick; `checkNote: null` fails it on the first low-confidence value; `attention` reading the review's
 * reasons alone (no read reason) fails it on the first row with a read reason the review is not unsure of ("f1:v0
 * attention false; needs checking true, entered false (copy)").
 */
export function checkWhy(s: UploadState, review: UploadReview, list: UploadList, fail: Fail) {
  const classified = new Map(review.classification.values.map((v) => [`${v.file}:${v.ref}`, v]));
  const byKey = new Map(list.rows.map((r) => [r.key, r]));
  let unworded = false;
  for (const { lf, i, st } of labReads(s, review)) {
    for (const at of offeredValues(st.extraction)) {
      const row = byKey.get(`${lf.fileId}:${at.ref}`);
      const v = classified.get(`${i}:${at.ref}`);
      if (!row || !v) continue;
      const words = [at.value.question, at.kind === 'core' && at.value.unitGuessed ? REVIEW_CELL_TEXT.checkUnit : undefined].filter(Boolean);
      if (JSON.stringify(row.reasons) !== JSON.stringify(words)) fail('L9', `${row.key} reasons ${JSON.stringify(row.reasons)}, read ${JSON.stringify(words)}`);
      const person = entered(st, at.ref);
      const unsure = v.group === 'unsure' && v.reasons.length > 0;
      const check = needsCheck(st, at, v, row.error);
      if (row.attention !== (check || person)) fail('L9', `${row.key} attention ${row.attention}; needs checking ${check}, entered ${person} (${row.status.kind})`);
      if (row.attention && unsure && !row.caption && !row.reasons.length && !row.error) unworded = true;
      if (!row.attention || row.caption || row.reasons.length || row.error || person || list.checkNote) continue;
      fail('L9', `${row.key} needs attention and says nothing, with no group note (${row.status.kind}, ${JSON.stringify(v)})`);
    }
  }
  if (list.checkNote !== (unworded ? IMPORT_REVIEW_TEXT.checkFooter : null)) fail('L9', `group note ${JSON.stringify(list.checkNote)}; a row unsure with no words of its own: ${unworded}`);
}

/**
 * L10 heading (owner ruling on PR 1949 review, G2). The heading counts the rows that need checking (`needsCheck`, from the
 * extraction, choices, review and faults), never a row only touched; Show all counts the rows outside the first group.
 * Mutation: the heading counted from the list's own `attention` fails it on the first touched row the review is sure of
 * ("heading "Check these 4 values" over 3 rows that need checking").
 */
export function checkHeading(s: UploadState, review: UploadReview, list: UploadList, fail: Fail) {
  const classified = new Map(review.classification.values.map((v) => [`${v.file}:${v.ref}`, v]));
  const byKey = new Map(list.rows.map((r) => [r.key, r]));
  let checks = 0;
  for (const { lf, i, st } of labReads(s, review)) {
    for (const at of offeredValues(st.extraction)) {
      const row = byKey.get(`${lf.fileId}:${at.ref}`);
      const v = classified.get(`${i}:${at.ref}`);
      if (row && v && needsCheck(st, at, v, row.error)) checks++;
    }
  }
  const quiet = list.rows.filter((r) => !r.attention).length;
  if (list.check !== (checks ? IMPORT_REVIEW_TEXT.checkTitle(checks) : null)) fail('L10', `heading ${JSON.stringify(list.check)} over ${checks} rows that need checking`);
  if (list.showAll !== (quiet ? IMPORT_REVIEW_TEXT.showAll(quiet) : null)) fail('L10', `Show all ${JSON.stringify(list.showAll)} over ${quiet} quiet rows`);
}

const AGAIN = ', another reading';
/**
 * L11 names (web list PR 1d; US-13 AC10). Each row's name is "<test> value from <file name>", then ", <day in words>" when
 * the review files it on a real past day, nothing more while it has no day; a later row with the same words adds
 * ", another reading". Names are distinct but where three or more rows share the words: KNOWN thirdReadingShared (noted,
 * Needs Brad). A row with a Replace and a day names its Replace with that day; two can share it (KNOWN
 * replaceLabelShared, noted). The file is named as `uploadFileName` names it (a ZIP member by its path). Mutations: `again` always false fails it
 * on the first two LDLs of one report and day; the file name left out of `from` fails it on the first row.
 */
export function checkNames(s: UploadState, review: UploadReview, list: UploadList, now: string, note: (gap: string) => void, fail: Fail) {
  const byKey = new Map(list.rows.map((r) => [r.key, r]));
  const bases = new Map<string, string[]>();
  for (const { lf, st } of labReads(s, review)) {
    const file = ('files' in s ? s.files : []).find((f) => f.id === lf.fileId)!;
    for (const at of offeredValues(st.extraction)) {
      const row = byKey.get(`${lf.fileId}:${at.ref}`);
      if (!row) continue;
      const base = row.name.endsWith(AGAIN) ? row.name.slice(0, -AGAIN.length) : row.name;
      const filed = lf.days[at.ref] ?? null;
      const day = filed === null ? null : validDay(filed, { now })?.slice(0, 10);
      const want = `${row.label} value from ${uploadFileName(file)}`;
      if (day === null ? base !== want : day ? base !== `${want}, ${longDate(day)}` : !base.startsWith(want)) fail('L11', `${row.key} named ${JSON.stringify(row.name)}, from ${JSON.stringify(want)} on ${day}`);
      bases.set(base, [...(bases.get(base) ?? []), row.name]);
      if (row.replaces && day && row.replaceLabel !== REVIEW_CELL_TEXT.replaceLabel(row.label, longDate(day)!)) fail('L11', `${row.key} Replace named ${JSON.stringify(row.replaceLabel)}`);
    }
  }
  const replaces = list.rows.flatMap((r) => (r.replaceLabel ? [r.replaceLabel] : []));
  // Two rows can replace one saved value (two files, one test, one day): the label names that saved value, so it is
  // shared; the screen ties each Replace to its row's name. KNOWN replaceLabelShared.
  if (new Set(replaces).size < replaces.length) note('replaceLabelShared');
  for (const [base, names] of bases) {
    if (names.length >= 3) { note('thirdReadingShared'); continue; }
    if (names.length === 2 && names.filter((n) => n === base).length !== 1) fail('L11', `two rows named ${JSON.stringify(names)}`);
  }
}

/**
 * L12 day-control names (owner ruling 2026-11-21). Each control's accessible name, its label, the day a dated column
 * printed in words (`printedLine`, `longDate` of the day it printed) and its file's name, is distinct in every state; both
 * previous columns say "Choose the date of the previous results". Two files of one name can share a control's name: KNOWN
 * sameNamedFileDays (noted; as their rows, no words tell them apart). Mutation: `printedLine` the report's day in words
 * instead of the column's (`longDate(lab.day)`) fails it on the first dated column; the name without its file's name, or
 * `fileName` the picked name rather than `uploadFileName` (a ZIP member without its ZIP), fails it on the first control.
 */
export function checkDayNames(s: UploadState, list: UploadList, note: (gap: string) => void, fail: Fail) {
  const files = new Map(('files' in s ? s.files : []).map((f) => [f.id, uploadFileName(f)]));
  const seen = new Map<string, string>();
  for (const d of list.days) {
    if (d.source !== 'test' && d.label !== DAY_CONTROL_TEXT.previous) fail('L12', `${d.key} labelled ${JSON.stringify(d.label)}`);
    if (d.source === 'column' && d.printedLine !== longDate(d.printed)) fail('L12', `${d.key} printed line ${JSON.stringify(d.printedLine)}`);
    const name = [d.label, d.source === 'column' ? d.printedLine : '', files.get(d.fileId)].filter(Boolean).join(', ');
    if (d.fileName !== files.get(d.fileId) || d.name !== name) fail('L12', `${d.key} file ${JSON.stringify(d.fileName)}, named ${JSON.stringify(d.name)}; want ${JSON.stringify(name)}`);
    const other = seen.get(name);
    if (other !== undefined) {
      if (other !== d.fileId && files.get(other) === files.get(d.fileId)) { note('sameNamedFileDays'); continue; }
      fail('L12', `two day controls named ${JSON.stringify(name)}`);
    }
    seen.set(name, d.fileId);
  }
}
