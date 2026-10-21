/**
 * How a plan's suggestions are laid out on screen: five sections, cards in a
 * fixed category order, and some categories merged into one grouped card.
 * One function, so the web's results panel and the iOS app show the same plan
 * in the same order (US-25 AC2). Layout only; it changes no suggestion.
 */
import type { Suggestion } from './types';

export type PlanSectionKey = 'urgent' | 'attention' | 'info' | 'skin' | 'supplements';

/** One card: a single suggestion, or two or more of a grouped category. */
export interface PlanCard {
  category: Suggestion['category'];
  /** The card's badge: the highest priority among its suggestions. */
  priority: Suggestion['priority'];
  suggestions: Suggestion[];
}

export interface PlanSection {
  key: PlanSectionKey;
  title: string;
  cards: PlanCard[];
}

/** Categories whose two or more suggestions in a section share one card. */
const GROUPED_CATEGORIES: readonly string[] = ['nutrition', 'screening', 'bloodwork', 'medication'];

/** Card order inside the first three sections; any other category follows, in arrival order. */
const CATEGORY_ORDER: readonly string[] = ['nutrition', 'exercise', 'sleep', 'screening', 'bloodwork', 'medication', 'blood_pressure', 'general'];

function highestPriority(suggestions: Suggestion[]): Suggestion['priority'] {
  if (suggestions.some((s) => s.priority === 'urgent')) return 'urgent';
  return suggestions.some((s) => s.priority === 'attention') ? 'attention' : 'info';
}

function card(suggestions: Suggestion[]): PlanCard {
  return { category: suggestions[0].category, priority: highestPriority(suggestions), suggestions };
}

function orderedCards(suggestions: Suggestion[]): PlanCard[] {
  const byCategory = new Map<string, Suggestion[]>();
  for (const s of suggestions) byCategory.set(s.category, [...(byCategory.get(s.category) ?? []), s]);

  const cards: PlanCard[] = [];
  for (const category of CATEGORY_ORDER) {
    const items = byCategory.get(category);
    if (!items) continue;
    if (GROUPED_CATEGORIES.includes(category) && items.length > 1) cards.push(card(items));
    else cards.push(...items.map((s) => card([s])));
  }
  for (const [category, items] of byCategory) {
    if (!CATEGORY_ORDER.includes(category)) cards.push(...items.map((s) => card([s])));
  }
  return cards;
}

/**
 * The plan's sections in display order, empty ones left out. Skin and
 * supplement suggestions keep engine order and are never grouped; one raised to
 * attention or urgent also shows in that priority's section.
 */
export function planSections(suggestions: Suggestion[]): PlanSection[] {
  const special = (s: Suggestion) => s.category === 'supplements' || s.category === 'skin';
  const sections: PlanSection[] = [
    { key: 'urgent', title: 'Requires Attention', cards: orderedCards(suggestions.filter((s) => s.priority === 'urgent')) },
    { key: 'attention', title: 'Next Steps', cards: orderedCards(suggestions.filter((s) => s.priority === 'attention')) },
    { key: 'info', title: 'Foundation', cards: orderedCards(suggestions.filter((s) => s.priority === 'info' && !special(s))) },
    { key: 'skin', title: 'Skin Health', cards: suggestions.filter((s) => s.category === 'skin').map((s) => card([s])) },
    { key: 'supplements', title: 'Supplements', cards: suggestions.filter((s) => s.category === 'supplements').map((s) => card([s])) },
  ];
  return sections.filter((section) => section.cards.length > 0);
}
