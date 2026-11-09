// Review-time dates: the report and column dates the review table edits, as day/month/year state.
import { validDay } from '@roadmap/health-core/record-edits';
import { isCalendarDay } from '@roadmap/health-core/measurement-history';
import { getCurrentDateValue } from '../components/DatePicker';
import { MONTHS_SHORT } from './constants';

/** Full date state: day/month/year. Day is null when the LLM didn't extract one. */
export interface FullDate {
  day: string | null; // "01"-"31" or null
  month: string;      // "1"-"12"
  year: string;       // "2024"
  /** An undated previous column the user has not dated yet (US-12 AC14):
   *  month and year are empty. */
  undated?: true;
}

/** A printed date as review state. A day is kept only if it exists in its
 *  month; a date with no real month (null, "June 2024", "2024-13") shows this
 *  month with no day (US-13 AC8). */
export function parseReportDate(dateStr: string | null): FullDate {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?(?:[T ]|$)/.exec(dateStr ?? '');
  if (!m || !isCalendarDay(`${m[1]}-${m[2]}-01`)) {
    const now = getCurrentDateValue();
    return { day: null, month: now.month, year: now.year };
  }
  return { day: m[3] && isCalendarDay(`${m[1]}-${m[2]}-${m[3]}`) ? m[3] : null, month: m[2], year: m[1] };
}

/** The date of an undated previous column until the user picks one: no
 *  month, so it never shares a column with the report's or any month's (US-12 AC14). */
export const UNDATED_DATE: FullDate = { day: null, month: '', year: '', undated: true };

/** "Jun" for "6" or "06". */
function monthLabel(month: string): string {
  return MONTHS_SHORT.find(m => m.value === month.padStart(2, '0'))?.label ?? month;
}

/** "5 Jan 2019" for 2019-01-05, "Jun 2025" for 2025-06; null for anything
 *  else (an undated column's key, `undated:<file>`, is no date). */
export function longDate(day: string): string | null {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(day);
  return m && `${m[3] ? `${Number(m[3])} ` : ''}${monthLabel(m[2])} ${m[1]}`;
}

/** A column's date when it is a calendar day that has happened, else null:
 *  only then is it set, and Save allowed (US-13 AC8). */
export function columnDay(date: FullDate): string | null {
  return date.day ? pastDay(fullDateToIso(date)) : null;
}

/** A calendar day that has happened, by this device's clock, or null. */
export function pastDay(raw: string | null | undefined): string | null {
  return validDay(raw, { now: new Date().toISOString() });
}

/** The model's document date as review state (US-13 AC6), read as the
 *  connector reads it: a past calendar day, else unknown. A month alone keeps
 *  no day, which is the user's to pick, but it may still date a screening. */
export function readDocumentDate(raw: string | null | undefined): { day: string | null; month: string | null } {
  const day = pastDay(raw);
  return { day, month: !day && raw && /^\d{4}-\d{2}$/.test(raw) && pastDay(`${raw}-01`) ? raw : null };
}

export function getDaysInMonth(month: string, year: string): number {
  return new Date(parseInt(year), parseInt(month), 0).getDate();
}

/** Build YYYY-MM-DD or YYYY-MM-01 ISO string from FullDate state. */
export function buildRecordedAt(date: FullDate): string {
  return `${fullDateToIso(date)}T00:00:00.000Z`;
}

/** YYYY-MM-DD, defaulting day to 01 when absent. */
export function fullDateToIso(date: FullDate): string {
  const month = date.month.padStart(2, '0');
  const day = (date.day ?? '01').padStart(2, '0');
  return `${date.year}-${month}-${day}`;
}

/** Inverse of fullDateToIso. Returns null on malformed input. */
export function parseIsoToFullDate(iso: string): FullDate | null {
  const [year, month, day] = iso.split('-');
  if (!year || !month || !day) return null;
  return { year, month, day };
}

/** What sets a value's date, and keys the date state: its file's report date,
 *  or its own printed day from a dated previous-results column (US-12 AC12),
 *  so editing one column's date never moves the other. */
export function dateSource(fi: number, recordedAt?: string): string {
  return recordedAt ? `${fi}@${recordedAt}` : String(fi);
}

/** Build the most precise date prefix for duplicate matching. */
export function buildDatePrefix(date: FullDate): string {
  const month = date.month.padStart(2, '0');
  if (date.day) {
    return `${date.year}-${month}-${date.day.padStart(2, '0')}`;
  }
  return `${date.year}-${month}`;
}


/** A column's date in words for a cell's label, so cells in one row read
 *  apart: "2 Sep 2025", "Sep 2025" with no day yet, or the undated column (US-13 AC10). */
export function columnWords(date: FullDate): string {
  if (date.undated) return 'the undated previous results';
  return longDate(`${date.year}-${date.month.padStart(2, '0')}${date.day ? `-${date.day.padStart(2, '0')}` : ''}`) ?? 'the new column';
}

export function formatColumnDate(date: FullDate): string {
  const yy = date.year.slice(-2);
  return date.day ? `${date.day} ${monthLabel(date.month)} '${yy}` : `${monthLabel(date.month)} '${yy}`;
}

