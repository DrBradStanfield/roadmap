import { getAvailableMonths, getYearOptions } from '../lib/constants';

export interface DateValue {
  year: string;
  month: string;
}

/**
 * Inline date picker variant without wrapper div, for embedding in rows
 */
interface InlineDatePickerProps {
  value: DateValue;
  onChange: (value: DateValue) => void;
  shortMonths?: boolean;
  yearCount?: number;
}

export function InlineDatePicker({
  value,
  onChange,
  shortMonths = true,
  yearCount = 11,
}: InlineDatePickerProps) {
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;

  const years = getYearOptions(yearCount);
  const availableMonths = getAvailableMonths(value.year, currentYear, currentMonth, shortMonths);

  const handleMonthChange = (newMonth: string) => {
    onChange({ ...value, month: newMonth });
  };

  const handleYearChange = (newYear: string) => {
    let newMonth = value.month;
    if (newYear === String(currentYear) && parseInt(value.month, 10) > currentMonth) {
      newMonth = String(currentMonth).padStart(2, '0');
    }
    onChange({ year: newYear, month: newMonth });
  };

  return (
    <>
      <select
        value={value.month}
        onChange={(e) => handleMonthChange(e.target.value)}
        aria-label="Month"
      >
        {availableMonths.map((m) => (
          <option key={m.value} value={m.value}>{m.label}</option>
        ))}
      </select>
      <select
        value={value.year}
        onChange={(e) => handleYearChange(e.target.value)}
        aria-label="Year"
      >
        {years.map((y) => (
          <option key={y} value={y}>{y}</option>
        ))}
      </select>
    </>
  );
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
