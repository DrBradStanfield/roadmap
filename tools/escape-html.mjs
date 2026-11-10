/**
 * escape-html.mjs — the one HTML escaper for scripts/ and tools/ (untangle T-7).
 *
 * Escapes & < > " ' so the result is safe in text and in a quoted attribute alike.
 * `&` goes first, so an entity this makes is never escaped twice. null and undefined
 * become '', and anything else is turned into a string first.
 * tools/escape-html.test.ts fails if a script or tool grows its own copy again.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
