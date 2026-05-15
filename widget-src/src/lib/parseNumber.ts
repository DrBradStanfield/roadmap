/**
 * Locale-aware decimal parser.
 *
 * Accepts both period and comma as decimal separators ("0.5" and "0,5"),
 * since European locales (German, French, Italian) use comma. Browsers'
 * built-in `<input type="number">` is inconsistent across locales, so we
 * normalise on parse rather than relying on the input element.
 *
 * Reused by ReviewTable inline edit (May 2026 redesign) and the
 * history-view correction form.
 */
export function parseLocalisedNumber(s: string): number | undefined {
  const trimmed = s.trim();
  if (trimmed === '' || trimmed === '-') return undefined;
  // Replace ALL commas with periods — if a user has both (thousands + decimal),
  // we don't try to be clever. Lab values never need thousands separators.
  const normalised = trimmed.replace(/,/g, '.');
  const n = Number(normalised);
  return Number.isFinite(n) ? n : undefined;
}
