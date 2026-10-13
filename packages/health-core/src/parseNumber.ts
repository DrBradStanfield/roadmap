/**
 * Locale-aware decimal parser.
 *
 * Accepts both period and comma as decimal separators ("0.5" and "0,5"),
 * since European locales (German, French, Italian) use comma. Browsers'
 * built-in `<input type="number">` is inconsistent across locales, so we
 * normalise on parse rather than relying on the input element.
 */
export function parseLocalisedNumber(s: string): number | undefined {
  // Replace ALL commas with periods — if a user has both (thousands + decimal),
  // we don't try to be clever. Lab values never need thousands separators.
  // Plain decimals only: Number() would also read "0x10", "1e3", "Infinity".
  const normalised = s.trim().replace(/,/g, '.');
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(normalised)) return undefined;
  const n = Number(normalised);
  return Number.isFinite(n) ? n : undefined;
}
