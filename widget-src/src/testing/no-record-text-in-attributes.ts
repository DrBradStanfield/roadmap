/**
 * US-09 AC7l: text from the person's record is shown as text, never copied into an attribute.
 * Walks every attribute of every element under `root` (the root too) and returns each one whose
 * value holds a sentinel, as `selector[attribute]="value"`, so a failing test names the place.
 *
 * Exempt: a form field's own `value` on a text-like input or a textarea (React mirrors a
 * controlled field's value into the attribute; that is the field itself). A checkbox, radio or
 * option carries its `value` as a fixed key, so theirs is checked. Also exempt: any element
 * matching one of `exempt`'s selectors (each with a comment where it is passed, saying why).
 *
 * A sentinel of digits and dots (a value as shown) matches only as a whole number, so "613"
 * finds "Lp(a): 613 nmol/L" and not a drawing's coordinate "2.46131".
 */
const FIELD = ['', 'text', 'number', 'email', 'date', 'search', 'tel'].map(t => (t ? `input[type="${t}"]` : 'input:not([type])')).concat('textarea').join(', ');

export function recordTextInAttributes(root: Element, sentinels: readonly string[], exempt: readonly string[] = []): string[] {
  const needles = sentinels.map(s => /^[\d.]+$/.test(s)
    ? new RegExp(`(?<![\\d.])${s.replace(/\./g, '\\.')}(?!\\.?\\d)`)
    : new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  return [root, ...root.querySelectorAll('*')].flatMap(el => {
    if (exempt.some(selector => el.matches(selector))) return [];
    return [...el.attributes]
      .filter(a => !(a.name === 'value' && el.matches(FIELD)))
      .filter(a => needles.some(n => n.test(a.value)))
      .map(a => `${describe(el)}[${a.name}]="${a.value}"`);
  });
}

function describe(el: Element): string {
  const cls = el.getAttribute('class')?.trim().split(/\s+/)[0];
  return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}`;
}
