export interface DateValue {
  year: string;
  month: string;
}

/**
 * Get current date as DateValue for initializing state
 */
export function getCurrentDateValue(): DateValue {
  const now = new Date();
  return {
    year: String(now.getFullYear()),
    month: String(now.getMonth() + 1).padStart(2, '0'),
  };
}
