/**
 * US-09 AC7l: text from the person's record is shown as text, never copied into an attribute.
 * Walks every attribute of every element under `root` (the root too) and returns each one whose
 * value holds a sentinel, as `selector[attribute]="value"`, so a failing test names the place.
 *
 * Exempt: a form control's own `value` (React mirrors a controlled input's value into the
 * attribute; that is the field itself), and any element matching one of `exempt`'s selectors
 * (each with a comment where it is passed, saying why).
 */
const FIELD = 'input, textarea, select, option';

export function recordTextInAttributes(root: Element, sentinels: readonly string[], exempt: readonly string[] = []): string[] {
  const needles = sentinels.map(s => s.toLowerCase());
  return [root, ...root.querySelectorAll('*')].flatMap(el => {
    if (exempt.some(selector => el.matches(selector))) return [];
    return [...el.attributes]
      .filter(a => !(a.name === 'value' && el.matches(FIELD)))
      .filter(a => needles.some(n => a.value.toLowerCase().includes(n)))
      .map(a => `${describe(el)}[${a.name}]="${a.value}"`);
  });
}

function describe(el: Element): string {
  const cls = el.getAttribute('class')?.trim().split(/\s+/)[0];
  return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}`;
}
