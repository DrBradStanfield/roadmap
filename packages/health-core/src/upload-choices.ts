/**
 * What the person chose for one read file (US-13 AC13, AC14; US-12 AC14): the upload machine
 * holds it on a read file and changes it only through `choose`. What the web's review can do
 * today, and the iPhone's: ticks, the test's day, an undated previous column's day (web only),
 * Replace on a conflict, an edited value, a document's title, kind and date.
 */
import { validDay } from './record-edits';

/** A document's corrections before Save (design Q3 (a)). `date` null: the person removed it. */
export interface DocumentFix { title?: string; kind?: string; date?: string | null }

/**
 * `ticks`: by value ref; absent, the platform's default (upload-rules `defaultTicked`).
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

/** The choices after one change, or null when the change is refused (an impossible document date). */
export function choose(c: FileChoices, change: ChoiceChange, now: string): FileChoices | null {
  if ('tick' in change) return { ...c, ticks: { ...c.ticks, [change.tick]: change.on } };
  if ('testDay' in change) return { ...c, testDay: change.testDay };
  if ('previousDay' in change) return { ...c, previousDay: change.previousDay };
  if ('replace' in change) return { ...c, replace: change.correctsId === null ? without(c.replace, change.replace) : { ...c.replace, [change.replace]: change.correctsId } };
  if ('edit' in change) return { ...c, edits: change.value === null || !Number.isFinite(change.value) ? without(c.edits, change.edit) : { ...c.edits, [change.edit]: change.value } };
  const { date, ...rest } = change.document;
  if (date === undefined) return { ...c, document: { ...c.document, ...rest } };
  const day = documentDate(date, now);
  return day === undefined ? null : { ...c, document: { ...c.document, ...rest, date: day } };
}
