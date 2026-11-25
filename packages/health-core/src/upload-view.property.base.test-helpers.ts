/**
 * The list-view property's shared ground: the seeds' random source, the days, a run's setup and steps, failures, and the
 * oracles that never read the view (K1, P5, P8, O). The harness and the properties' list: upload-view.property.test-helpers.ts.
 */
import { UNDATED_PREVIOUS, type UnifiedExtractionResult } from './lab-extraction';
import { bulkRowTarget } from './bulk-row-target';
import { bulkAppendValues, slotKey, slotOfRow, validDay, type BulkRow } from './record-edits';
import { createEmptyFile, type FileLabValue, type FileMeasurement, type RoadmapFile } from './roadmap-file';
import type { ChoiceChange, FileChoices } from './upload-choices';
import type { UploadEvent, UploadState } from './upload-flow';
import type { UploadReview } from './upload-review';
import type { UploadPlatform } from './upload-rules';
import type { UploadView, ValueRow } from './upload-view';
import { importRow, isOfferedRef, offeredValues, PROBE_DAY, valueAt } from './import-review';
import type { UnitSystem } from './units';

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Row ids for a sweep. Production mints them with crypto.randomUUID (record-edits.ts newId, with no seam to pass a
 * source), and ids steer a run: mergeFiles sorts rows by id and breaks a createdAt tie by the larger id (merge.ts
 * rowIsNewer), and every row here is created at NOW. With random ids 24 of 3000 seeds took a different number of steps
 * from one run to the next, and a failing seed could move. While `withSeededIds` runs, the ids are valid v4 UUIDs from
 * their own stream, reset by `seedIds` for each seed and phase, never drawn from the generator's.
 */
let ids: (() => number) | null = null;
export const seedIds = (seed: number, phase: 'setup' | 'run') => { ids = mulberry32(((seed * 2 + (phase === 'run' ? 1 : 0)) ^ 0x9e3779b9) >>> 0); };
const seededUuid = () => {
  if (!ids) throw new Error('seededUuid outside a seed: call seedIds first');
  const hex = Array.from({ length: 32 }, () => Math.floor(ids!() * 16).toString(16));
  hex[12] = '4';
  hex[16] = (8 + Math.floor(ids() * 4)).toString(16);
  const h = hex.join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}` as `${string}-${string}-${string}-${string}-${string}`;
};
export async function withSeededIds<T>(body: () => Promise<T>): Promise<T> {
  const own = Object.getOwnPropertyDescriptor(globalThis.crypto, 'randomUUID');
  Object.defineProperty(globalThis.crypto, 'randomUUID', { configurable: true, writable: true, value: seededUuid });
  try { return await body(); } finally {
    if (own) Object.defineProperty(globalThis.crypto, 'randomUUID', own);
    else delete (globalThis.crypto as { randomUUID?: unknown }).randomUUID;
    ids = null;
  }
}

export const NOW = '2026-11-02T00:00:00.000Z';
export const DAY = '2026-11-01';
export const PAST = '2026-10-01';
export const PICKED_DAY = '2026-10-20';
export const FUTURE = '2026-12-01';
/** A previous column's day before every report and test day the run picks. */
export const EARLY = '2026-09-01';
/** A second past day a web report prints, as a dated previous column (US-13 AC24). */
export const COLUMN = '2026-09-15';
/** A misread report date that has not happened: the only way the server keeps a future own day (lab-extraction.ts `ownDay`: own < report). */
export const REPORT_FUTURE = '2026-12-15';

/** `failWrites`: files whose original the cloud refuses (an unstored original). `platform`: the device the run is on.
 *  `system`: the units the person reads core values in, given to the web's view only (the phone passes none). */
export interface Setup { extractions: Record<string, UnifiedExtractionResult>; record: RoadmapFile; cloud: boolean; failWrites: string[]; platform: UploadPlatform; system: UnitSystem }

// --- events: the machine's own, plus the record and Save steps the platform runs -------------

export type Step =
  | { type: 'event'; e: UploadEvent }
  /** Another writer: these rows appended to the record now; `merge`: on another device's copy of the record as the
   *  upload began, merged in (`mergeFiles`), as a cloud read brings it. */
  | { type: 'record'; rows: BulkRow[]; merge: boolean }
  /** Another writer deletes a held row (entered in error, no correction): a Replace aimed at it is lost. */
  | { type: 'delete'; id: string }
  /** Save tapped on the page drawn before another writer acts (rows appended, or `free`: a held row deleted): the app
   *  sends back the drawn page's `reviewed`. */
  | { type: 'tap'; rows: BulkRow[]; merge: boolean; free: string | null }
  /** One Save as the platform runs it: `uploadSave` on the record, commit on it, or on it after `meanwhile`. */
  | { type: 'save'; ok: boolean; meanwhile: BulkRow[] | null; merge: boolean; free: string | null; when: 'beforeSave' | 'beforeCommit' };

type Row = FileMeasurement | FileLabValue;
export const rowsOf = (f: RoadmapFile): Row[] => [...f.measurements, ...f.labValues];
export const isActive = (row: Row) => (row.status ?? 'active') === 'active';
export const key = (fileId: string, ref: string) => `${fileId}|${ref}`;

/** The rows the view shows ticked and writable: ticked, no error, not out of range, no conflict kept, the report not waiting for its day. */
export function shownWritable(view: UploadView, review: UploadReview, s: UploadState): Set<string> {
  const waiting = new Set(review.labFiles.filter((f) => f.needsDay).map((f) => f.fileId));
  const out = new Set<string>();
  for (const row of allRows(view)) {
    if (!row.ticked || row.error || row.copy || row.reasons.includes('outOfRange') || waiting.has(row.fileId)) continue;
    // `uploadView` is the phone's, which never holds typed text (PHONE_STATE); the web draws `uploadList`, whose L5 checks
    // a row holding text with no exemption.
    if (heldAt(s, row.fileId, row.ref)) continue;
    if (row.conflict !== null && !row.replacing) continue;
    out.add(key(row.fileId, row.ref));
  }
  return out;
}
const heldAt = (s: UploadState, fileId: string, ref: string) => ('files' in s ? s.files : []).some((f) => f.id === fileId && f.status.s === 'read' && f.status.choices.typed?.[ref] !== undefined);
export const allRows = (view: UploadView): ValueRow[] => [
  ...view.sections.flatMap((s) => (s.kind === 'unsure' ? s.rows : [])),
  ...(view.sure?.rows ?? []),
];
/** The values the review writes, by file and ref (`classification.rows` in order). */
export const written = (review: UploadReview) => new Set(review.classification.values.filter((v) => v.sent && v.writes).map((v) => key(review.labFiles[v.file].fileId, v.ref)));

export class Failure extends Error { constructor(public prop: string, msg: string) { super(`${prop}: ${msg}`); } }
export const fail = (prop: string, msg: string): never => { throw new Failure(prop, msg); };

/** A known gap seen, by name. */
export type Note = (gap: string) => void;

/** A value's day source as its control's key, from the day it printed alone (never the view's `dayKey`). */
export function sourceKey(fileId: string, x: UnifiedExtractionResult, ref: string): string {
  const printed = valueAt(x, ref)?.value.recordedAt;
  return `${fileId}|${printed === undefined ? 'test' : printed === UNDATED_PREVIOUS ? 'previous' : `printed:${printed}`}`;
}

/** The write refuses this value whatever its day (a lab's unit or number), as Save would send it: it asks no day. */
export function refusedAnyDay(st: { extraction: UnifiedExtractionResult; choices: FileChoices }, ref: string): boolean {
  const edit = st.choices.edits[ref];
  const row = importRow(st.extraction, ref, PROBE_DAY, edit !== undefined ? { edited: { value: edit } } : {});
  return !!row && bulkAppendValues(createEmptyFile({ deviceId: 'oracle', now: NOW }), [row], NOW).refused.length > 0;
}

/** A day change the list's date input can send: a whole day (it ignores an emptied input and never sends part of one). */
export const fullDayChange = (c: ChoiceChange) => {
  const day = 'testDay' in c ? c.testDay : 'previousDay' in c ? c.previousDay : 'columnDay' in c ? c.day : undefined;
  return typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day);
};

/**
 * K1: a day change keeps each day control's key: before and after, and always the one its kind and file name (never the
 * day). In its file it moves only its own source's rows, but a test day may also take or give back a previous column's
 * day (its pick must be before the test's: the row's day becomes none, or its pick); no other file's row moves.
 * Mutation that fails it: the test-day control's key holding the day picked.
 */
export function checkDayChange(before: UploadView, after: UploadView, s: UploadState, e: Extract<UploadEvent, { type: 'chose' }>) {
  const keys = (v: UploadView) => new Map(v.sections.flatMap((x) => ('key' in x ? [[`${x.kind} ${x.fileId}`, x.key] as const] : [])));
  const was = keys(before);
  for (const [id, k] of keys(after)) {
    const [kind, fileId] = id.split(' ');
    if (k !== `${fileId}|${kind === 'undated' ? 'test' : 'previous'}`) fail('K1', `${id}'s control is keyed ${k}`);
    if (was.has(id) && was.get(id) !== k) fail('K1', `${id}'s control was ${was.get(id)}, now ${k}`);
  }
  const change = e.change;
  const source = 'testDay' in change ? 'test' : 'previousDay' in change ? 'previous' : 'columnDay' in change ? `printed:${change.columnDay}` : null;
  const day = new Map(allRows(before).map((r) => [key(r.fileId, r.ref), r.day]));
  for (const row of allRows(after)) {
    const k = key(row.fileId, row.ref);
    if (!day.has(k) || day.get(k) === row.day) continue;
    const st = 'files' in s ? s.files.find((f) => f.id === row.fileId)?.status : undefined;
    if (st?.s !== 'read') continue;
    const own = sourceKey(row.fileId, st.extraction, row.ref);
    if (row.fileId === e.id && own === `${e.id}|${source}`) continue;
    // The before-the-test rule: a previous column's row loses its day, or gets its pick back, when the test's day moves.
    const printed = valueAt(st.extraction, row.ref)?.value.recordedAt;
    const pick = printed === UNDATED_PREVIOUS ? st.choices.previousDay : st.choices.columnDays?.[printed ?? ''];
    if (row.fileId === e.id && source === 'test' && !own.endsWith('|test') && (row.day === null || row.day === validDay(pick ?? undefined, { now: NOW })?.slice(0, 10))) continue;
    fail('K1', `a ${source} day change in ${e.id} moved ${k} (${own}) from ${day.get(k)} to ${row.day}`);
  }
}

/**
 * Independent oracles (adversary R2), from the generated case and the record, never from the classifier's own rule:
 * a `saved` value has an equal active reading in its slot, or an equal reading of this upload there that writes or is
 * held; a not-saved value's reason is its generated cause (an unknown unit, a creatinine with no unit, an own day still
 * to come, or another reading of the test that day); a future-day value's own day is after today.
 */
export function checkOracles(s: UploadState, review: UploadReview, record: RoadmapFile) {
  const today = NOW.slice(0, 10);
  const reads = new Map(('files' in s ? s.files : []).flatMap((f) => (f.status.s === 'read' ? [[f.id, f.status] as const] : [])));
  const held = rowsOf(record).filter(isActive);
  // A value is judged on the number Save would send, its edit included; one not sent too, on the web alone (import-review
  // step 3; owner ruling 2026-11-21: the phone's preview reads the number read, KNOWN phoneEditPreview).
  const facts = (fi: number, ref: string, sent = true) => {
    const lf = review.labFiles[fi];
    const st = reads.get(lf.fileId)!;
    const x = st.extraction;
    const printed = valueAt(x, ref)?.value;
    const own = printed?.recordedAt === UNDATED_PREVIOUS ? undefined : printed?.recordedAt;
    const { day } = expectedDay(st, ref);
    const edit = st.choices.edits[ref];
    const row = day ? importRow(x, ref, day, edit !== undefined && (sent || s.platform === 'web') ? { edited: { value: edit } } : {}) : null;
    return { printed, own, row, slot: row ? slotKey(bulkRowTarget(row).slot, bulkRowTarget(row).metric, row.recordedAt) : null };
  };
  const values = review.classification.values;
  for (const v of values) {
    if (v.ref[0] === 'r') { if (v.group !== 'notSaved' || v.reason !== 'noUnit') fail('O', `${v.ref} refused row is ${v.group}`); continue; }
    if (!isOfferedRef(v.ref)) continue;
    // A value whose dated column waits for its pick has no day (US-13 AC24): it is never written, and judged on no day.
    if (expectedDay(reads.get(review.labFiles[v.file].fileId)!, v.ref).waits) { if (v.sent && v.writes) fail('O', `${v.ref} waits for its column's day and is written`); continue; }
    const f = facts(v.file, v.ref, v.sent);
    if (v.group === 'saved') {
      if (!f.row || !f.slot) fail('O', `${v.ref} saved with no day`);
      const equal = (value: number) => Math.abs(value - f.row!.value) < 1e-9;
      const inRecord = held.some((h) => slotOfRow(h) === f.slot && equal(h.value) && (h.comparator ?? null) === (f.row!.comparator ?? null));
      // A winner holding typed text keeps its slot but is not written (web list PR 1b); Save is blocked meanwhile.
      const holds = (o: { file: number; ref: string }) => heldAt(s, review.labFiles[o.file].fileId, o.ref);
      const sibling = 'duplicate' in v && v.duplicate && values.some((o) => o !== v && o.sent && (o.writes || o.group === 'saved' || holds(o)) && facts(o.file, o.ref).slot === f.slot && facts(o.file, o.ref).row && equal(facts(o.file, o.ref).row!.value));
      if (!inRecord && !sibling) fail('O', `${review.labFiles[v.file].fileId} ${v.ref} classed saved with no equal reading held or written in ${f.slot}`);
    }
    if (v.group === 'notSaved') {
      const unit = v.ref[0] === 'a' && (f.printed as { unit?: string } | undefined)?.unit === 'zzz';
      const future = f.own !== undefined && f.own > today;
      // Each generated cause; a value with two (an unknown unit on a day still to come) may be named for either.
      const causes = [...(unit ? ['unit'] : []), ...(future ? [v.ref[0] === 'v' ? 'futureCoreDay' : 'futureDay'] : [])];
      if (!causes.length) causes.push('sameDay');
      if (!causes.includes(v.reason)) fail('O', `${v.ref} not saved for ${v.reason}, its generated cause is ${causes.join(' or ')}`);
      if (causes[0] === 'sameDay' && !values.some((o) => o !== v && o.sent && facts(o.file, o.ref).slot === f.slot)) fail('O', `${v.ref} sameDay with no other reading that day`);
      if ((v.reason === 'futureDay' || v.reason === 'futureCoreDay') && !(f.own && f.own > today)) fail('O', `${v.ref} future-day with own day ${f.own}`);
    }
  }
}

/** P8: the review's day for each offered value (`days`, `waits`) is the one worked out from the extraction and the choices alone. */
export function checkDays(s: UploadState, review: UploadReview) {
  for (const lf of review.labFiles) {
    const f = 'files' in s ? s.files.find((x) => x.id === lf.fileId) : undefined;
    if (f?.status.s !== 'read') continue;
    for (const { ref } of offeredValues(f.status.extraction)) {
      const want = expectedDay(f.status, ref);
      const got = lf.days[ref]?.slice(0, 10) ?? null;
      if (got !== want.day || lf.waits.includes(ref) !== want.waits) fail('P8', `${lf.fileId}|${ref} has day ${got}${lf.waits.includes(ref) ? ' (waits)' : ''}, expected ${want.day}${want.waits ? ' (waits)' : ''}`);
    }
  }
}

/**
 * A value's day from the raw extraction and the choices alone, never from the review: the test's (the picked day, else
 * the report's); its own printed day (one still to come as printed: it is never saved); the undated column's pick, or a
 * dated column's (US-13 AC24), when that is a real past day before the test's (any while the test has none), else none;
 * a dated column with a pick that is not such a day waits.
 */
export function expectedDay(st: { extraction: UnifiedExtractionResult; choices: FileChoices }, ref: string): { day: string | null; waits: boolean } {
  const { extraction: x, choices } = st;
  const real = (d: string | null | undefined) => (d ? validDay(d, { now: NOW })?.slice(0, 10) ?? null : null);
  const test = real(choices.testDay ?? x.reportDate);
  const before = (pick: string | null | undefined) => { const d = real(pick); return d && (!test || d < test) ? d : null; };
  const printed = valueAt(x, ref)?.value.recordedAt;
  if (printed === undefined) return { day: test, waits: false };
  if (printed === UNDATED_PREVIOUS) return { day: before(choices.previousDay), waits: false };
  const pick = real(printed) ? choices.columnDays?.[printed] : undefined;
  if (pick === undefined) return { day: printed.slice(0, 10), waits: false };
  const day = before(pick);
  return { day, waits: day === null };
}

/** P5: FHIR after a commit of `before` into `after`. */
export function checkFhir(before: RoadmapFile, after: RoadmapFile) {
  const slots = new Map<string, number>();
  for (const row of rowsOf(after)) if (isActive(row)) slots.set(slotOfRow(row), (slots.get(slotOfRow(row)) ?? 0) + 1);
  for (const [slot, n] of slots) if (n > 1) fail('P5', `${n} active rows in ${slot}`);
  const now = new Map(rowsOf(after).map((row) => [row.id, row]));
  for (const old of rowsOf(before)) {
    const next = now.get(old.id);
    if (!next) fail('P5', `row ${old.id} removed`);
    const flipped = isActive(old) && next!.status === 'entered-in-error';
    if (flipped) {
      if (!rowsOf(after).some((row) => row.correctsId === old.id && isActive(row))) fail('P5', `${old.id} flipped with no correction`);
      if (JSON.stringify({ ...next, status: old.status }) !== JSON.stringify(old)) fail('P5', `${old.id} changed beyond its status`);
    } else if (JSON.stringify(next) !== JSON.stringify(old)) fail('P5', `${old.id} mutated`);
  }
  for (const row of rowsOf(after)) {
    if (now.get(row.id) && rowsOf(before).some((b) => b.id === row.id)) continue;
    if (row.correctsId && !rowsOf(before).some((b) => b.id === row.correctsId)) fail('P5', `${row.id} corrects a row the record never held`);
  }
}

/** A valid early day for each column a lab file waits on (`waits`, by the day each value printed). */
export function columnFixes(s: UploadState, lf: UploadReview['labFiles'][number]): ChoiceChange[] {
  const f = 'files' in s ? s.files.find((x) => x.id === lf.fileId) : undefined;
  if (f?.status.s !== 'read') return [];
  const { extraction } = f.status;
  return [...new Set(lf.waits.map((ref) => valueRecordedAt(extraction, ref)!))].map((columnDay) => ({ columnDay, day: EARLY }));
}

/** The person's units, as the web's view takes them; the phone's view gets none. */
export const unitsOf = (setup: Setup) => (setup.platform === 'web' ? () => setup.system : undefined);

export const valueRecordedAt = (x: UnifiedExtractionResult, ref: string) => valueAt(x, ref)?.value.recordedAt;
