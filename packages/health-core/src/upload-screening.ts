/**
 * A letter's screening box (US-13 AC6), moved from the web's review unchanged (ReviewFileSections.tsx,
 * useReviewDocuments.ts, review-dates.ts `readDocumentDate`): a letter whose reader named a screening type the
 * person is eligible for offers "Update <type> screening date"; ticked, Save writes `<type>_last_date` with the
 * letter's date, in the same record edit as the letter (upload-save.ts). Web only (owner ruling on the mount
 * note, 2026-11-22): the iPhone shows no box and writes no screening date from a letter, so a phone upload
 * never has one. Pure.
 */
import { validDay } from './record-edits';
import { isScreeningEligible } from './types';

/** Who the plan is for, as the web's plan has it: age and sex set eligibility (US-06 AC5). */
export interface ScreeningPerson { age?: number; sex?: 'male' | 'female' }

/** A letter's box: the reader's screening type, the key it writes, the date it would write (none yet: the box is
 *  disabled), and whether it is ticked. */
export interface ScreeningBox { type: string; key: string; date: string | null; ticked: boolean }

/** The box's words, byte for byte as the web's review drew them (ReviewFileSections.tsx): "Update ", the type in
 *  bold, then the tail. */
export const SCREENING_BOX_TEXT = {
  lead: 'Update ',
  tail: (date: string | null): string => ` screening date${date ? ` to ${date}` : ' (pick the document date first)'}`,
} as const;

/** The model's document date (US-13 AC6), read as the connector reads it: a past calendar day, else unknown. A month
 *  alone keeps no day, which is the person's to pick, but it may still date a screening. */
export function letterDate(raw: string | null | undefined, now: string): { day: string | null; month: string | null } {
  const day = validDay(raw, { now });
  return { day, month: !day && raw && /^\d{4}-\d{2}$/.test(raw) && validDay(`${raw}-01`, { now }) ? raw : null };
}

/** The reader's screening type, when it named one and the person is eligible for it: the box shows. */
export function screeningTypeShown(metadata: Record<string, unknown> | null | undefined, person: ScreeningPerson): string | null {
  const type = metadata?.screeningType;
  return type && isScreeningEligible(String(type), person.age, person.sex) ? String(type) : null;
}

/** Ticked by default only with a known age: with none, eligibility is unknown (US-06 AC5). The person can still tick it. */
export const screeningTickedByDefault = (person: ScreeningPerson): boolean => person.age !== undefined;

/**
 * A letter's box, or null when it shows none. `raw`: the date the letter starts from (a held row's, else the reader's);
 * `fixed`: the person's date fix, when they set or removed one (a day, or null), which drops a month-only date.
 * `ticked`: the person's tick, absent for the default.
 */
export function screeningBox(
  metadata: Record<string, unknown> | null | undefined, raw: string | null | undefined, fixed: string | null | undefined,
  ticked: boolean | undefined, person: ScreeningPerson, now: string,
): ScreeningBox | null {
  const type = screeningTypeShown(metadata, person);
  if (!type) return null;
  const { day, month } = fixed !== undefined ? { day: fixed, month: null } : letterDate(raw, now);
  return { type, key: `${type}_last_date`, date: day ?? month, ticked: ticked ?? screeningTickedByDefault(person) };
}
