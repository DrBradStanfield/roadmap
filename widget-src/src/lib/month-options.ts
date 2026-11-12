import { screeningMonths } from '@roadmap/health-core/input-form';
import { MONTHS_FULL } from './constants';

export interface MonthOption { value: string; label: string }
export interface MonthGroup { year: string; options: MonthOption[] }

/** "November 2026" for 2026-11; anything else as it is. */
function monthLabel(value: string): string {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(value);
  return m ? `${MONTHS_FULL[Number(m[2]) - 1].label} ${m[1]}` : value;
}

/**
 * A screening date's whole-month choices, grouped by year (US-06 AC16): the months health-core
 * allows (the iPhone's list too), none before `min`. A past date lists the newest first, a
 * future one the earliest. `extra`: a stored value outside them, exactly as stored.
 */
export function monthOptions({ when, today, min, stored }: {
  when: 'past' | 'future'; today: string; min?: string; stored?: string;
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
