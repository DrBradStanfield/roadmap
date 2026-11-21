// The web upload ledger's properties (web list PR 1b), for upload-view.property.test.ts. Not shipped: only tests import it.
// Each oracle reads the extraction, the choices, the units table and (for a kept conflict or a refused blood pressure
// pair) the review, never what `uploadList` computed. The mutation each was shown failing on is named beside it.
import { commaQuestion } from './parseNumber';
import { cellRange, rangeMessage, type CellUnit } from './cell-unit';
import { ENTER_A_NUMBER, NUMERIC_SYNTAX_GUIDANCE } from './cell-input';
import { offeredValues, type ClassifiedValue } from './import-review';
import { UNDATED_PREVIOUS } from './lab-extraction';
import { rangeFault, UNIT_DEFS, type MetricType } from './units';
import type { TypedText } from './upload-choices';
import type { UploadState } from './upload-flow';
import type { UploadList } from './upload-list';
import type { UploadReview } from './upload-review';
import type { UploadView } from './upload-view';

type Fail = (prop: string, msg: string) => never;
/** What the person entered in each row, by `fileId:ref`, as the harness logged it from their own events (L7 keeps it). */
export type PersonInputs = ReadonlyMap<string, { typed: TypedText | null; edit: number | undefined }>;
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

/**
 * L7 input kept. Across every step that is not the person's own choice on a row (door steps, record changes, reads
 * landing, Save and its outcome), each row's held text and edit are what the person's own events left; only a choice
 * naming that row changes them. The log is the harness's own. Mutation: `replacesLost` reducing with the person's clear
 * (held text erased by a lost Replace) fails it.
 */
export function keepInputs(s: UploadState, inputs: Map<string, { typed: TypedText | null; edit: number | undefined }>, chosen: string | null, fail: Fail) {
  if (!('files' in s)) { inputs.clear(); return; }
  for (const f of s.files) {
    if (f.status.s !== 'read') continue;
    for (const { ref } of offeredValues(f.status.extraction)) {
      const key = `${f.id}:${ref}`;
      const now = { typed: f.status.choices.typed?.[ref] ?? null, edit: f.status.choices.edits[ref] };
      if (key === chosen) { inputs.set(key, now); continue; }
      const was = inputs.get(key) ?? { typed: null, edit: undefined };
      if (JSON.stringify(was) !== JSON.stringify(now)) fail('L7', `${key} changed without the person: ${JSON.stringify(was)} -> ${JSON.stringify(now)}`);
      inputs.set(key, now);
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
 * reads the cells' guidance. A blocker sits at the row exactly when it holds text, or is a ticked, selected, faulty core value.
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
      const blocks = !!typed || (ticked && fault && !unselected(review, v) && at.kind === 'core');
      if (open && blocked.has(key) !== blocks) fail('L4', `${key} blocker ${blocked.has(key)}, expected ${blocks} (status ${row.status.kind})`);
      if ((row.status.kind === 'error') !== blocks) fail('L4', `${key} status ${row.status.kind}, blocks ${blocks}`);
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
