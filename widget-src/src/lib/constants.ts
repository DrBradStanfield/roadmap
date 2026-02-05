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
): typeof MONTHS_FULL | typeof MONTHS_SHORT {
  const months = short ? MONTHS_SHORT : MONTHS_FULL;
  if (selectedYear === String(currentYear)) {
    return months.filter(m => parseInt(m.value, 10) <= currentMonth) as typeof months;
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
 * Format a date string or Date object to a short locale string (e.g., "Jan 15, 2024")
 */
export function formatShortDate(date: string | Date): string {
  return new Date(date).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Clinical threshold constants for UI display
 */
export const CLINICAL_THRESHOLDS = {
  PSA_NORMAL: 4.0, // ng/mL
  BP_TARGET_STANDARD: { systolic: 130, diastolic: 80 },
  BP_TARGET_OPTIMAL: { systolic: 120, diastolic: 80 },
  EZETIMIBE_DOSE: 10, // mg
} as const;
