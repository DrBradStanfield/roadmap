/**
 * US-13 AC10: accessibility text that holds a number. Session replay and
 * error tools capture aria-label, title, alt and aria-valuetext, so those may
 * hold a test's own name and a date in words, never a value. Returns each
 * such text that still has a digit once the row names the page shows
 * (`.bt-name-label`: "Vitamin B12", "HbA1c") and its dates in words
 * ("2 Sep 2025", "Sep 2025") are taken out.
 */
const MONTH = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)';
const DATE_IN_WORDS = new RegExp(`\\b(?:\\d{1,2} )?${MONTH} \\d{4}\\b`, 'g');
const ATTRIBUTES = ['aria-label', 'title', 'alt', 'aria-valuetext'];

export function a11yTextWithDigits(root: ParentNode): string[] {
  const names = [...root.querySelectorAll('.bt-name-label')].map(el => el.textContent ?? '').filter(Boolean);
  const allowed = (text: string) => names.reduce((t, name) => t.split(name).join(''), text).replace(DATE_IN_WORDS, '');
  return [...root.querySelectorAll(ATTRIBUTES.map(a => `[${a}]`).join(', '))]
    .flatMap(el => ATTRIBUTES.map(a => el.getAttribute(a)).filter((t): t is string => t !== null))
    .filter(text => /\d/.test(allowed(text)));
}
