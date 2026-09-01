/**
 * Shared UI constants for the health widget
 */

// Month arrays for date pickers
export const MONTHS_FULL = [
  { value: '01', label: 'January' },
  { value: '02', label: 'February' },
  { value: '03', label: 'March' },
  { value: '04', label: 'April' },
  { value: '05', label: 'May' },
  { value: '06', label: 'June' },
  { value: '07', label: 'July' },
  { value: '08', label: 'August' },
  { value: '09', label: 'September' },
  { value: '10', label: 'October' },
  { value: '11', label: 'November' },
  { value: '12', label: 'December' },
] as const;

export const MONTHS_SHORT = [
  { value: '01', label: 'Jan' },
  { value: '02', label: 'Feb' },
  { value: '03', label: 'Mar' },
  { value: '04', label: 'Apr' },
  { value: '05', label: 'May' },
  { value: '06', label: 'Jun' },
  { value: '07', label: 'Jul' },
  { value: '08', label: 'Aug' },
  { value: '09', label: 'Sep' },
  { value: '10', label: 'Oct' },
  { value: '11', label: 'Nov' },
  { value: '12', label: 'Dec' },
] as const;

/**
 * Get available months for a date picker, filtering out future months if in the current year
 */
export function getAvailableMonths(
  selectedYear: string,
  currentYear: number,
  currentMonth: number,
  short = false
): ReadonlyArray<{ value: string; label: string }> {
  const months = short ? MONTHS_SHORT : MONTHS_FULL;
  if (selectedYear === String(currentYear)) {
    return months.filter(m => parseInt(m.value, 10) <= currentMonth);
  }
  return months;
}

/**
 * Generate an array of year options for date pickers
 */
export function getYearOptions(count = 11): number[] {
  const currentYear = new Date().getFullYear();
  return Array.from({ length: count }, (_, i) => currentYear - i);
}

/**
 * Format a date string, Date or epoch ms to a short locale string (e.g., "Jan 15, 2024").
 *
 * A stored `recordedAt` for a dated row is a calendar SLOT widened to UTC
 * midnight — `2026-09-02T00:00:00.000Z` means "2 September", and dedup keys on
 * that day. Read through the reader's own timezone it renders a day early west
 * of Greenwich, so day-shaped input is formatted in UTC. A real instant is a
 * moment, and still renders in local time.
 */
export function formatShortDate(date: string | Date | number): string {
  const slot = typeof date === 'string'
    ? /^\d{4}-\d{2}-\d{2}$/.test(date) || /T00:00:00(\.000)?Z$/.test(date)
    : new Date(date).getTime() % 86_400_000 === 0;
  return new Date(date).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: slot ? 'UTC' : undefined,
  });
}
