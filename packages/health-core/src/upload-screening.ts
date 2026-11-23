/**
 * A letter's screening box (US-13 AC6), moved from the web's review unchanged (ReviewFileSections.tsx,
 * useReviewDocuments.ts, review-dates.ts `readDocumentDate`): a letter whose reader named a screening type the
 * person is eligible for offers "Update <type> screening date"; ticked, Save writes `<type>_last_date` with the
 * letter's date, in the same record edit as the letter (upload-save.ts). Web only (owner ruling on the mount
 * note, 2026-11-22): the iPhone shows no box and writes no screening date from a letter, so a phone upload
 * never has one. Pure.
 */
import { screeningFieldName } from './file-inputs';
import { validDay } from './record-edits';
import { screeningDate } from './screening-inputs';
import type { RoadmapFile } from './roadmap-file';
import { setScreening } from './state-edits';
import { longDate } from './upload-text';
import { isScreeningEligible } from './types';
import { SCREENING_KEYS } from './validation';

/** The screening table's last-date keys (validation.ts SCREENING_KEYS): a box is offered, and a date written, only for these. */
const LAST_DATE_KEYS: ReadonlySet<string> = new Set(SCREENING_KEYS.filter((k) => k.endsWith('_last_date')));
/** A key in the screening table that a letter's box may write. */
export const isScreeningDateKey = (key: string): boolean => LAST_DATE_KEYS.has(key);

/** Who the plan is for, as the web's plan has it: age and sex set eligibility (US-06 AC5). */
export interface ScreeningPerson { age?: number; sex?: 'male' | 'female' }

/** A letter's box: the reader's screening type, the key it writes, the date it would write (none yet: the box is
 *  disabled), and whether it is ticked. */
export interface ScreeningBox { type: string; key: string; date: string | null; ticked: boolean }

/** The box's words, byte for byte as the web's review drew them (ReviewFileSections.tsx): "Update ", the type in
 *  bold, then the tail. */
export const SCREENING_BOX_TEXT = {
  lead: 'Update ',
  tail: (date: string | null): string => ` screening date${date ? ` to ${longDate(date) ?? date}` : ' (pick the document date first)'}`,
} as const;

/** The model's document date (US-13 AC6), read as the connector reads it: a past calendar day, else unknown. A month
 *  alone keeps no day, which is the person's to pick, but it may still date a screening. */
export function letterDate(raw: string | null | undefined, now: string): { day: string | null; month: string | null } {
  const day = validDay(raw, { now });
  return { day, month: !day && raw && /^\d{4}-\d{2}$/.test(raw) && validDay(`${raw}-01`, { now }) ? raw : null };
}

/** Where a read letter starts, before the person's fixes: the reader's title, day and month (`letterDate`), from its
 *  answer in the upload state alone, never from the record, so the card, its box and what Save writes cannot part
 *  (owner ruling on PR 1957, 2026-11-22; US-13 AC6, US-14 AC4). */
export interface LetterStart { title: string; day: string | null; month: string | null }
export const letterStart = (doc: { title: string; documentDate?: string | null }, now: string): LetterStart =>
  ({ title: doc.title, ...letterDate(doc.documentDate, now) });

/** The reader's screening type, when it named one in the screening table and the person is eligible for it: the box
 *  shows. Any other type gives no box. */
export function screeningTypeShown(metadata: Record<string, unknown> | null | undefined, person: ScreeningPerson): string | null {
  const type = metadata?.screeningType;
  return typeof type === 'string' && isScreeningDateKey(`${type}_last_date`) && isScreeningEligible(type, person.age, person.sex) ? type : null;
}

/** A date as a day, compared as text so it is the same in every time zone: a month alone is its first day; anything
 *  else is none. */
const asDay = (date: unknown): string | null => {
  const m = typeof date === 'string' ? /^(\d{4}-\d{2})(-\d{2})?$/.exec(date) : null;
  return m ? `${m[1]}${m[2] ?? '-01'}` : null;
};
/** A screening date only ever moves forward (Brad 2026-11-23): `date` is later than the day the record holds for `key`,
 *  or the record holds none. The held date is read as the plan reads it (screening-inputs `screeningDate`, a "last done"
 *  date by `now`), so one the plan does not read as a date counts as none. The person can still set an earlier date by
 *  hand in the form. */
const movesForward = (file: RoadmapFile, key: string, date: string, now: string): boolean => {
  const day = asDay(date);
  const stored = (file.screenings as unknown as Record<string, unknown>)[screeningFieldName(key)];
  const held = asDay(typeof stored === 'string' ? screeningDate(stored, new Date(now)) : undefined);
  return day !== null && (held === null || day > held);
};

/** The dates a Save writes, `[key, date]`: only a key in the screening table, whatever the caller hands it. Among dates
 *  of one key the latest stands, whatever their order, and it lands through `setScreening`, stamped `now`, only when it
 *  moves the record's date forward, so a retry or a repeat writes nothing. `written`: the dates it wrote. */
export function writeScreeningDates(file: RoadmapFile, dates: Iterable<readonly [string, string]>, now: string): { file: RoadmapFile; written: number } {
  const latest = new Map<string, string>();
  for (const [key, date] of dates) {
    const was = latest.get(key);
    if (isScreeningDateKey(key) && (was === undefined || (asDay(date) ?? '') > (asDay(was) ?? ''))) latest.set(key, date);
  }
  let out = file;
  let written = 0;
  for (const [key, date] of latest) {
    if (movesForward(out, key, date, now)) { out = setScreening(out, key, date, now); written++; }
  }
  return { file: out, written };
}

/** Ticked by default only with a known age: with none, eligibility is unknown (US-06 AC5). The person can still tick it. */
export const screeningTickedByDefault = (person: ScreeningPerson): boolean => person.age !== undefined;

/**
 * A letter's box, or null when it shows none. `start`: where the letter starts (`letterStart`), as its card does;
 * `fixed`: the person's date fix, when they set or removed one (a day, or null), which drops a month-only date.
 * `ticked`: the person's tick, absent for the default. A dated letter no later than the date `record` holds for its
 * type shows none: Save would not write it (Brad 2026-11-23).
 */
export function screeningBox(
  metadata: Record<string, unknown> | null | undefined, start: LetterStart, fixed: string | null | undefined,
  ticked: boolean | undefined, person: ScreeningPerson, record: RoadmapFile, now: string,
): ScreeningBox | null {
  const type = screeningTypeShown(metadata, person);
  if (!type) return null;
  const key = `${type}_last_date`;
  const date = fixed !== undefined ? fixed : start.day ?? start.month;
  if (date !== null && !movesForward(record, key, date, now)) return null;
  return { type, key, date, ticked: ticked ?? screeningTickedByDefault(person) };
}
