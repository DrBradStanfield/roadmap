/** 1-3 digits (no leading 0), a comma and exactly 3 digits. */
const AMBIGUOUS_COMMA = /^[+-]?[1-9]\d{0,2},\d{3}$/;
const GROUPED_THOUSANDS = /^[+-]?[1-9]\d{0,2}(,\d{3}){2,}$/;

/**
 * Locale-aware decimal parser.
 *
 * Accepts both period and comma as decimal separators ("0.5" and "0,5"),
 * since European locales (German, French, Italian) use comma. Browsers'
 * built-in `<input type="number">` is inconsistent across locales, so we
 * normalise on parse rather than relying on the input element.
 *
 * One comma before exactly three digits ("1,234") is US thousands (1234) or
 * a European decimal (1.234), 1000x apart (US-02 AC7). It reads as thousands
 * only when they are inside `range` (the test's input range in the unit typed,
 * not a clinical target) and the decimal reading is below it; the decimal
 * reading is never chosen. Otherwise it is refused, and `commaQuestion` says
 * what to ask. Two or more comma groups ("1,234,567") are thousands, read only
 * against a range, which the caller then checks. A comma and a dot together
 * are refused.
 */
export function parseLocalisedNumber(s: string, range?: { min: number; max: number }): number | undefined {
  const t = s.trim();
  if (AMBIGUOUS_COMMA.test(t)) {
    const thousands = Number(t.replace(',', ''));
    const inRange = !!range && thousands >= range.min && thousands <= range.max && Number(t.replace(',', '.')) < range.min;
    return inRange ? thousands : undefined;
  }
  if (GROUPED_THOUSANDS.test(t)) return range ? Number(t.replace(/,/g, '')) : undefined;
  // Plain decimals only: Number() would also read "0x10", "1e3", "Infinity".
  const normalised = t.replace(/,/g, '.');
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(normalised)) return undefined;
  const n = Number(normalised);
  return Number.isFinite(n) ? n : undefined;
}

/** What to ask about a number `parseLocalisedNumber` refused for its commas:
 *  "Did you mean 1234 or 1.234?", or, for grouped thousands with no range to
 *  check them, to type it plainly; null when the comma is not the reason. */
export function commaQuestion(s: string): string | null {
  const t = s.trim();
  if (GROUPED_THOUSANDS.test(t)) return 'Type the number without commas.';
  return AMBIGUOUS_COMMA.test(t) ? `Did you mean ${Number(t.replace(',', ''))} or ${Number(t.replace(',', '.'))}?` : null;
}
