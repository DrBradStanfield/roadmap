/** An aria-describedby value from the ids of the text that describes an
 *  element, skipping any not shown; undefined when none is (US-13 AC10). */
export function describedBy(...ids: (string | false | null | undefined)[]): string | undefined {
  return ids.filter(Boolean).join(' ') || undefined;
}
