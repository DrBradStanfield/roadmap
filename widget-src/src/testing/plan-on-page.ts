// Test support: reading the plan off My health (US-62 phase 5), where a
// suggestion is a card in its topic or a line on its row (a medicine question,
// a screening test), and the tiles sit on their rows' pages. Imported by tests only.
import { fireEvent } from '@testing-library/react';

const rowTitle = (row: Element) => row.querySelector('.mh-info-btn')?.getAttribute('aria-label')?.replace(/^About: /, '') ?? '';

/** Every suggestion's title on the page: the cards' and the rows'. */
export function planTitles(root: ParentNode = document): string[] {
  return [...root.querySelectorAll('.suggestion-title, .mh-row-suggestion')]
    .map(el => (el.classList.contains('mh-row-suggestion') ? rowTitle(el) : el.textContent ?? ''));
}

/** The text of the suggestion with this title, a card's or a row's (its info opened); undefined when none. */
export function suggestionText(root: ParentNode, title: string): string | undefined {
  const card = [...root.querySelectorAll('.suggestion-title')].find(t => t.textContent === title);
  if (card) return card.parentElement?.querySelector('.suggestion-desc')?.textContent ?? undefined;
  const row = [...root.querySelectorAll('.mh-row-suggestion')].find(r => rowTitle(r) === title);
  if (!row) return undefined;
  const info = row.querySelector<HTMLButtonElement>('.mh-info-btn')!;
  if (info.getAttribute('aria-expanded') !== 'true') fireEvent.click(info);
  return row.querySelector('.mh-row-suggestion-detail .suggestion-desc')?.textContent
    ?? row.querySelector('.mh-row-suggestion-text')?.textContent ?? undefined;
}

/** The plan's BMI, from the weight row's target line ("BMI 27.4", US-62 AC21). */
export function bmiOnRow(root: ParentNode = document): string | undefined {
  const weight = [...root.querySelectorAll('.md-row')].find(r => r.querySelector('.md-row-label')?.textContent === 'Weight');
  return /BMI ([\d.]+)/.exec(weight?.querySelector('.md-row-meta')?.textContent ?? '')?.[1];
}
