/**
 * What the person chose for one read file (US-13 AC13, AC14; US-12 AC14): the upload machine
 * holds it on a read file and changes it only through `choose`. What the web's review can do
 * today, and the iPhone's: ticks, the test's day, an undated previous column's day (web only),
 * Replace on a conflict, an edited value, a document's title, kind and date.
 */
import { UNDATED_PREVIOUS, type UnifiedExtractionResult } from './lab-extraction';
import { offeredValues, valueAt } from './import-review';
import { typedCommit } from './cell-input';
import type { CellUnit } from './cell-unit';
import { validDay } from './record-edits';

/** A document's corrections before Save (design Q3 (a)). `date` null: the person removed it. */
export interface DocumentFix { title?: string; kind?: string; date?: string | null }

/**
 * `ticks`: by value ref; absent, ticked: saved unless cleared, on both clients (Brad 2026-11-20).
 * `replace`: a conflict's held row id by ref: the value saves as its correction (`correctsId`).
 * `edits`: the number the person typed by ref (a core value in SI, a lab in its own unit),
 * saved as edited (`lab_import_edited`), as the web's cells save it.
 */
export interface FileChoices {
  ticks: Record<string, boolean>;
  testDay: string | null;
  previousDay: string | null;
  replace: Record<string, string>;
  edits: Record<string, number>;
  document: DocumentFix;
  /** A dated previous column's day by the day it printed (web only, US-13 AC24): a real past day, or a pick
   *  still waiting to be one (a part missing, a day to come), kept so the column shows it while the report waits. */
  columnDays?: Record<string, string>;
  /** Text typed into a row that is no number, by ref, with the unit it was typed in (web only, US-13 AC5, AC12): it stays
   *  in its row, explained, and blocks Save until a number, an emptied input or a cleared tick replaces it. Absent is none. */
  typed?: Record<string, TypedText>;
}
/** Held text and its unit: a core value's (so "1,234" keeps the unit it was typed in), null for a lab. */
export interface TypedText { text: string; unit: CellUnit | null }
export type ChoiceChange =
  | { tick: string; on: boolean }
  | { testDay: string | null }
  | { previousDay: string | null }
  | { replace: string; correctsId: string | null }
  | { edit: string; value: number | null }
  | { document: DocumentFix }
  | { columnDay: string; day: string | null }
  /** Text typed into a row and committed (web only; `cell-input.ts` `typedCommit`). */
  | { typed: string; text: string; unit: CellUnit | null };

export const NO_CHOICES: FileChoices = { ticks: {}, testDay: null, previousDay: null, replace: {}, edits: {}, document: {} };

/** A document date the person set: a real calendar day that has happened, or null (removed); else refused. */
export function documentDate(date: string | null, now: string): string | null | undefined {
  return date === null ? null : validDay(date, { now }) ?? undefined;
}

const without = <T,>(r: Record<string, T>, key: string): Record<string, T> => Object.fromEntries(Object.entries(r).filter(([k]) => k !== key));

/** A row's held text dropped; the key absent when none is left, as before any was typed. */
function unheld(c: FileChoices, ref: string): FileChoices {
  if (!c.typed?.[ref]) return c;
  const { typed: _, ...rest } = c;
  const typed = without(c.typed, ref);
  return Object.keys(typed).length ? { ...rest, typed } : rest;
}

/** A value cleared: unticked, its Replace dropped (a Replace selects its value), and any text held in its row. */
export const untick = (c: FileChoices, ref: string): FileChoices => ({ ...unheld(c, ref), ticks: { ...c.ticks, [ref]: false }, replace: without(c.replace, ref) });

/** The refs a day change moves: values on the test's day (no day of their own), in the undated previous column, or printed on one day. */
function movedRefs(x: Pick<UnifiedExtractionResult, 'values' | 'additionalValues'>, own: string | undefined): string[] {
  return offeredValues(x).filter(({ value }) => value.recordedAt === own).map(({ ref }) => ref);
}

/** A Replace never follows its value to another day (US-13 AC7): a day that changes clears the moved values' Replace. */
function moved(c: FileChoices, refs: string[], before: string | null, after: string | null, now: string): Record<string, string> {
  if (validDay(before ?? undefined, { now }) === validDay(after ?? undefined, { now })) return c.replace;
  return Object.fromEntries(Object.entries(c.replace).filter(([ref]) => !refs.includes(ref)));
}

/**
 * The choices after one change, or null when the change is refused (an impossible document
 * date, a column day for no real past day a value printed). `extraction`: the file's, to know which values a day change moves.
 */
export function choose(c: FileChoices, change: ChoiceChange, now: string, extraction: Pick<UnifiedExtractionResult, 'values' | 'additionalValues' | 'reportDate'>): FileChoices | null {
  // Replace saves the value as a correction, so it selects the value; clearing a value drops its Replace.
  if ('tick' in change) return change.on ? { ...c, ticks: { ...c.ticks, [change.tick]: true } } : untick(c, change.tick);
  if ('testDay' in change) {
    const report = extraction.reportDate ?? null;
    return { ...c, testDay: change.testDay, replace: moved(c, movedRefs(extraction, undefined), c.testDay ?? report, change.testDay ?? report, now) };
  }
  if ('previousDay' in change) return { ...c, previousDay: change.previousDay, replace: moved(c, movedRefs(extraction, UNDATED_PREVIOUS), c.previousDay, change.previousDay, now) };
  if ('replace' in change) {
    if (change.correctsId === null) return { ...c, replace: without(c.replace, change.replace) };
    return { ...c, replace: { ...c.replace, [change.replace]: change.correctsId }, ticks: { ...c.ticks, [change.replace]: true } };
  }
  if ('columnDay' in change) {
    // Only a real past day some value printed: never the undated column (its own pick), nor a printed day to
    // come, which is never saved (owner ruling 2026-11-20, US-13 AC15). Else refused.
    const refs = validDay(change.columnDay, { now }) ? movedRefs(extraction, change.columnDay) : [];
    if (!refs.length) return null;
    // The pick as given, as the other days are: one that is no real past day makes the report wait (upload-review.ts `needsColumnDay`).
    const { day } = change;
    const columnDays = day === null ? without(c.columnDays ?? {}, change.columnDay) : { ...c.columnDays, [change.columnDay]: day };
    return { ...c, columnDays, replace: moved(c, refs, c.columnDays?.[change.columnDay] ?? change.columnDay, day ?? change.columnDay, now) };
  }
  if ('edit' in change) return { ...unheld(c, change.edit), edits: change.value === null || !Number.isFinite(change.value) ? without(c.edits, change.edit) : { ...c.edits, [change.edit]: change.value } };
  if ('typed' in change) {
    // An emptied input unticks its row and drops its text (owner ruling 2026-11-21); text that is no number stays, held.
    if (!change.text.trim()) return untick(c, change.typed);
    const at = valueAt(extraction, change.typed);
    const commit = at && typedCommit(change.text, at, c.edits[change.typed], change.unit);
    if (!commit) return null;
    // Anything typed into a cleared row ticks it again (owner ruling 2026-11-21): a number to save, or held text, which
    // then blocks Save at that row until it is fixed or cleared.
    const kept = { ...unheld(c, change.typed), ...(c.ticks[change.typed] === false ? { ticks: { ...c.ticks, [change.typed]: true } } : {}) };
    if (commit.kind === 'hold') return { ...kept, typed: { ...c.typed, [change.typed]: { text: change.text, unit: change.unit } } };
    return commit.kind === 'same' ? kept : { ...kept, edits: { ...c.edits, [change.typed]: commit.value } };
  }
  const { date, ...rest } = change.document;
  if (date === undefined) return { ...c, document: { ...c.document, ...rest } };
  const day = documentDate(date, now);
  return day === undefined ? null : { ...c, document: { ...c.document, ...rest, date: day } };
}
