/**
 * Text cut to at most `max` characters at a boundary (US-12 AC12): the last
 * line end, else the last whitespace, else the cap itself, backed out of a
 * number and never between the halves of a surrogate pair. A value is never
 * sent half-written.
 */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  const lineEnd = text.lastIndexOf('\n', max);
  if (lineEnd > 0) return text.slice(0, lineEnd);
  const space = text.slice(0, max + 1).search(/\s\S*$/);
  if (space > 0) return text.slice(0, space);
  let end = max;
  while (end > 0 && /[\d.,]/.test(text[end - 1]) && /[\d.,]/.test(text[end])) end--;
  if (/[\ud800-\udbff]/.test(text[end - 1] ?? '')) end--;
  return text.slice(0, end);
}
