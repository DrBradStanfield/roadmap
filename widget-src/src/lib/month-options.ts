import { screeningMonths } from '@roadmap/health-core/input-form';
import { MONTHS_FULL } from './constants';

export interface MonthOption { value: string; label: string }
export interface MonthGroup { year: string; options: MonthOption[] }

/** "November 2026" for 2026-11, "15 March 2024" for 2024-03-15; anything else as it is. */
function monthLabel(value: string): string {
  const m = /^(\d{4})-(0[1-9]|1[0-2])(?:-(0[1-9]|[12]\d|3[01]))?$/.exec(value);
  if (!m) return value;
  const monthYear = `${MONTHS_FULL[Number(m[2]) - 1].label} ${m[1]}`;
  return m[3] ? `${Number(m[3])} ${monthYear}` : monthYear;
}

/**
 * A screening date's whole-month choices, grouped by year (US-06 AC16): the months health-core
 * allows (the iPhone's list too). A past date lists the newest first, a
 * future one the earliest. `min` (YYYY-MM, the form field's) drops every month before it (US-07 AC1j).
 * `extra`: a stored value outside them, exactly as stored.
 */
export function monthOptions({ when, today, stored, min }: {
  when: 'past' | 'future'; today: string; stored?: string; min?: string;
}): { extra?: MonthOption; groups: MonthGroup[] } {
  const months = screeningMonths(when, today).filter(m => !min || m >= min);
  const groups: MonthGroup[] = [];
  for (const value of when === 'past' ? [...months].reverse() : months) {
    const year = value.slice(0, 4);
    if (groups[groups.length - 1]?.year !== year) groups.push({ year, options: [] });
    groups[groups.length - 1].options.push({ value, label: monthLabel(value) });
  }
  const extra = stored && !months.includes(stored) ? { value: stored, label: monthLabel(stored) } : undefined;
  return { extra, groups };
}
