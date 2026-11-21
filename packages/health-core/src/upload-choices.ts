/**
 * What the person chose for one read file (US-13 AC13, AC14; US-12 AC14): the upload machine
 * holds it on a read file and changes it only through `choose`. What the web's review can do
 * today, and the iPhone's: ticks, the test's day, an undated previous column's day (web only),
 * Replace on a conflict, an edited value, a document's title, kind and date.
 */
import { UNDATED_PREVIOUS, type UnifiedExtractionResult } from './lab-extraction';
import { offeredValues } from './import-review';
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
}
export type ChoiceChange =
  | { tick: string; on: boolean }
  | { testDay: string | null }
  | { previousDay: string | null }
  | { replace: string; correctsId: string | null }
  | { edit: string; value: number | null }
  | { document: DocumentFix };

export const NO_CHOICES: FileChoices = { ticks: {}, testDay: null, previousDay: null, replace: {}, edits: {}, document: {} };

/** A document date the person set: a real calendar day that has happened, or null (removed); else refused. */
export function documentDate(date: string | null, now: string): string | null | undefined {
  return date === null ? null : validDay(date, { now }) ?? undefined;
}

const without = <T,>(r: Record<string, T>, key: string): Record<string, T> => Object.fromEntries(Object.entries(r).filter(([k]) => k !== key));

/** A value cleared: unticked, and its Replace dropped, since a Replace selects its value. */
export const untick = (c: FileChoices, ref: string): FileChoices => ({ ...c, ticks: { ...c.ticks, [ref]: false }, replace: without(c.replace, ref) });

/** The refs a day change moves: values on the test's day (no day of their own), or in the undated previous column. */
function movedRefs(x: Pick<UnifiedExtractionResult, 'values' | 'additionalValues'>, column: 'test' | 'previous'): string[] {
  const on = (own?: string) => (column === 'test' ? own === undefined : own === UNDATED_PREVIOUS);
  return offeredValues(x).filter(({ value }) => on(value.recordedAt)).map(({ ref }) => ref);
}

/** A Replace never follows its value to another day (US-13 AC7): a day that changes clears the moved values' Replace. */
function moved(c: FileChoices, refs: string[], before: string | null, after: string | null, now: string): Record<string, string> {
  if (validDay(before ?? undefined, { now }) === validDay(after ?? undefined, { now })) return c.replace;
  return Object.fromEntries(Object.entries(c.replace).filter(([ref]) => !refs.includes(ref)));
}

/**
 * The choices after one change, or null when the change is refused (an impossible document
 * date). `extraction`: the file's, to know which values a day change moves.
 */
export function choose(c: FileChoices, change: ChoiceChange, now: string, extraction: Pick<UnifiedExtractionResult, 'values' | 'additionalValues' | 'reportDate'>): FileChoices | null {
  // Replace saves the value as a correction, so it selects the value; clearing a value drops its Replace.
  if ('tick' in change) return change.on ? { ...c, ticks: { ...c.ticks, [change.tick]: true } } : untick(c, change.tick);
  if ('testDay' in change) {
    const report = extraction.reportDate ?? null;
    return { ...c, testDay: change.testDay, replace: moved(c, movedRefs(extraction, 'test'), c.testDay ?? report, change.testDay ?? report, now) };
  }
  if ('previousDay' in change) return { ...c, previousDay: change.previousDay, replace: moved(c, movedRefs(extraction, 'previous'), c.previousDay, change.previousDay, now) };
  if ('replace' in change) {
    if (change.correctsId === null) return { ...c, replace: without(c.replace, change.replace) };
    return { ...c, replace: { ...c.replace, [change.replace]: change.correctsId }, ticks: { ...c.ticks, [change.replace]: true } };
  }
  if ('edit' in change) return { ...c, edits: change.value === null || !Number.isFinite(change.value) ? without(c.edits, change.edit) : { ...c.edits, [change.edit]: change.value } };
  const { date, ...rest } = change.document;
  if (date === undefined) return { ...c, document: { ...c.document, ...rest } };
  const day = documentDate(date, now);
  return day === undefined ? null : { ...c, document: { ...c.document, ...rest, date: day } };
}
