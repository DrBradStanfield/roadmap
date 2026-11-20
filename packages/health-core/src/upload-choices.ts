/**
 * What the person chose for one read file (US-13 AC13, AC14; US-12 AC14): the upload machine
 * holds it on a read file and changes it only through `choose`. What the web's review can do
 * today, and the iPhone's: ticks, the test's day, an undated previous column's day (web only),
 * Replace on a conflict, an edited value, a document's title, kind and date.
 */
import { UNDATED_PREVIOUS, type UnifiedExtractionResult } from './lab-extraction';
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
  /** A letter's screening update (web, US-06 AC5): absent, the platform's default (upload-plan.ts). */
  screening?: boolean;
  /** A dated previous-results column's day, by the day it printed (web, US-12 AC12): a real past day, or a pick still waiting to be one. */
  columnDays?: Record<string, string>;
}
export type ChoiceChange =
  | { tick: string; on: boolean }
  | { testDay: string | null }
  | { previousDay: string | null }
  | { replace: string; correctsId: string | null }
  | { edit: string; value: number | null }
  | { document: DocumentFix }
  | { screening: boolean }
  | { columnDay: string; day: string | null };

export const NO_CHOICES: FileChoices = { ticks: {}, testDay: null, previousDay: null, replace: {}, edits: {}, document: {} };

/** A document date the person set: a real calendar day that has happened, or null (removed); else refused. */
export function documentDate(date: string | null, now: string): string | null | undefined {
  return date === null ? null : validDay(date, { now }) ?? undefined;
}

const without = <T,>(r: Record<string, T>, key: string): Record<string, T> => Object.fromEntries(Object.entries(r).filter(([k]) => k !== key));

/** The refs a day change moves: values on the test's day (no day of their own), in the undated previous column, or printed on one day. */
function movedRefs(x: Pick<UnifiedExtractionResult, 'values' | 'additionalValues'>, column: 'test' | 'previous' | { printed: string }): string[] {
  const on = (own?: string) => (column === 'test' ? own === undefined : column === 'previous' ? own === UNDATED_PREVIOUS : own === column.printed);
  return [
    ...(x.values ?? []).flatMap((v, i) => (on(v.recordedAt) ? [`v${i}`] : [])),
    ...(x.additionalValues ?? []).flatMap((v, i) => (on(v.recordedAt) ? [`a${i}`] : [])),
  ];
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
  if ('tick' in change) return { ...c, ticks: { ...c.ticks, [change.tick]: change.on } };
  if ('testDay' in change) {
    const report = extraction.reportDate ?? null;
    return { ...c, testDay: change.testDay, replace: moved(c, movedRefs(extraction, 'test'), c.testDay ?? report, change.testDay ?? report, now) };
  }
  if ('previousDay' in change) return { ...c, previousDay: change.previousDay, replace: moved(c, movedRefs(extraction, 'previous'), c.previousDay, change.previousDay, now) };
  if ('replace' in change) return { ...c, replace: change.correctsId === null ? without(c.replace, change.replace) : { ...c.replace, [change.replace]: change.correctsId } };
  if ('screening' in change) return { ...c, screening: change.screening };
  if ('columnDay' in change) {
    // A real past day as `validDay` gives it; any other pick (a part missing, a day to come) as given,
    // so the column keeps showing it and the report waits for a day (upload-review.ts).
    const day = change.day === null ? null : validDay(change.day, { now }) ?? change.day;
    const before = c.columnDays?.[change.columnDay] ?? change.columnDay;
    const columnDays = day === null ? without(c.columnDays ?? {}, change.columnDay) : { ...c.columnDays, [change.columnDay]: day };
    return { ...c, columnDays, replace: moved(c, movedRefs(extraction, { printed: change.columnDay }), before, day ?? change.columnDay, now) };
  }
  if ('edit' in change) return { ...c, edits: change.value === null || !Number.isFinite(change.value) ? without(c.edits, change.edit) : { ...c.edits, [change.edit]: change.value } };
  const { date, ...rest } = change.document;
  if (date === undefined) return { ...c, document: { ...c.document, ...rest } };
  const day = documentDate(date, now);
  return day === undefined ? null : { ...c, document: { ...c.document, ...rest, date: day } };
}
