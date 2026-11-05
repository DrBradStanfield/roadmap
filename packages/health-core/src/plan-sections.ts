/**
 * How a plan's suggestions are laid out on screen: five sections, cards in a
 * fixed category order, and some categories merged into one grouped card.
 * One function, so the web's results panel and the iOS app show the same plan
 * in the same order (US-25 AC2). Layout only; it changes no suggestion.
 * `topicSections` lays the same cards out by topic, for the iPhone's My health (US-73).
 */
import type { FormField, FormSection } from './input-form';
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

/** The missing-measurement prompts, waist then blood pressure: they lead their section, in
 *  this order, ahead of every category (US-07 AC11). Ordering only: suggestions.ts names its cards itself. */
export const LEADING_IDS = ['measure-waist', 'measure-bp'] as const;
const isLeading = (id: string) => (LEADING_IDS as readonly string[]).includes(id);

function highestPriority(suggestions: Suggestion[]): Suggestion['priority'] {
  if (suggestions.some((s) => s.priority === 'urgent')) return 'urgent';
  return suggestions.some((s) => s.priority === 'attention') ? 'attention' : 'info';
}

function card(suggestions: Suggestion[]): PlanCard {
  return { category: suggestions[0].category, priority: highestPriority(suggestions), suggestions };
}

function orderedCards(suggestions: Suggestion[]): PlanCard[] {
  const cards: PlanCard[] = LEADING_IDS.flatMap((id) => suggestions.filter((s) => s.id === id).map((s) => card([s])));
  const byCategory = new Map<string, Suggestion[]>();
  for (const s of suggestions) {
    if (!isLeading(s.id)) byCategory.set(s.category, [...(byCategory.get(s.category) ?? []), s]);
  }

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

// ---------------------------------------------------------------------------
// My health (US-73): the same cards by topic
// ---------------------------------------------------------------------------

/** The iPhone's My health sections, in order (US-73 AC2); `other` takes a suggestion no rule places. */
export type TopicId = 'weight' | 'sleep' | 'fitness' | 'bloodPressure' | 'cholesterol' | 'screening' | 'skin' | 'bloodTests' | 'supplements' | 'other';

const TOPICS: ReadonlyArray<{ topic: TopicId; title: string }> = [
  { topic: 'weight', title: 'Weight & diabetes' },
  { topic: 'sleep', title: 'Sleep' },
  { topic: 'fitness', title: 'Fitness' },
  { topic: 'bloodPressure', title: 'Blood pressure' },
  { topic: 'cholesterol', title: 'Cholesterol' },
  { topic: 'screening', title: 'Cancer screening' },
  { topic: 'skin', title: 'Skin' },
  { topic: 'bloodTests', title: 'Blood tests' },
  { topic: 'supplements', title: 'Supplements' },
  { topic: 'other', title: 'Other' },
];

/** A card of one topic: an input card's suggestions about that topic, badged by their highest priority. */
export interface TopicCard<S extends Suggestion = Suggestion> { category: Suggestion['category']; priority: Suggestion['priority']; suggestions: S[] }

export interface TopicSection<S extends Suggestion = Suggestion> {
  topic: TopicId;
  title: string;
  cards: TopicCard<S>[];
  /** US-61 AC7: who owns the products, under the supplement cards, when the input carried it. */
  ownershipLine?: string;
}

/**
 * Where every suggestion goes on My health (US-73 AC3): a card in a topic, or a
 * row. `medicines` sit on their medicine question (by its key), `screenings` on
 * their screening group (by its id), each in engine order. An urgent one in a
 * row is a card too.
 */
export interface TopicLayout<S extends Suggestion = Suggestion> {
  sections: TopicSection<S>[];
  medicines: Array<{ key: string; suggestions: S[] }>;
  screenings: Array<{ group: string; suggestions: S[] }>;
}

/** The lipid cards' ids (suggestions.ts): ApoB, LDL, non-HDL, Lp(a), total cholesterol, HDL, triglycerides. */
const LIPID_PREFIXES = ['apob-', 'ldl-', 'non-hdl-', 'lpa-', 'total-chol-', 'hdl-', 'trig-'];

/** A suggestion's topic: by category, nutrition and bloodwork by id; a medicine's is its cascade's. */
export function topicOf(s: Pick<Suggestion, 'id' | 'category'>): TopicId {
  switch (s.category) {
    case 'nutrition':
      if (s.id === 'low-salt' || s.id === 'high-potassium') return 'bloodPressure';
      return s.id === 'lipid-diet' || s.id === 'trig-nutrition' ? 'cholesterol' : 'weight';
    case 'bloodwork':
      if (s.id.startsWith('hba1c-')) return 'weight';
      return LIPID_PREFIXES.some((p) => s.id.startsWith(p)) ? 'cholesterol' : 'bloodTests';
    case 'medication':
      return s.id.startsWith('weight-') ? 'weight' : s.id.startsWith('med-') ? 'cholesterol' : 'other';
    case 'general': return 'weight';
    case 'exercise': return 'fitness';
    case 'sleep': return 'sleep';
    case 'blood_pressure': return 'bloodPressure';
    case 'screening': return 'screening';
    case 'skin': return 'skin';
    case 'supplements': return 'supplements';
    default: return 'other';
  }
}

/** The medicine questions a suggestion sits beside, best first: its step's own
 *  (`med-statin-dose` to `statin_dose`), the escalation, then the drug's. */
export function questionKeys(id: string): string[] {
  const prefix = ['weight-med-', 'weight-', 'med-'].find((p) => id.startsWith(p));
  const key = (prefix ? id.slice(prefix.length) : id).replace(/-/g, '_');
  const drug = key.split('_')[0];
  return [key, `${drug}_escalation`, drug];
}

/** The screening group a suggestion is about, by its id: `screening-lung-overdue` is lung's. */
export function screeningGroupOf(s: Pick<Suggestion, 'id' | 'category'>): string | null {
  return s.category === 'screening' && s.id.startsWith('screening-') ? s.id.slice('screening-'.length).split('-')[0] : null;
}

const RANK: Record<Suggestion['priority'], number> = { urgent: 0, attention: 1, info: 2 };
const isResult = (card: TopicCard) => card.suggestions.some((s) => s.category === 'bloodwork' || s.category === 'blood_pressure');

/**
 * The plan's cards by topic (US-73 AC3, AC4), from planSections' sections (or
 * the US overlay's) and the form's questions. A card whose suggestions fall in
 * two topics becomes one card in each. A medicine suggestion sits on the first
 * of its questions the form asks, and a screening one on its group when the
 * form asks that group; anything else is a card, a medicine with no question
 * among them, so nothing is dropped. An urgent one in a row is a card as well
 * (Brad 2026-11-05). Within a topic: urgent, then attention, then info; within
 * a level a card about a result before lifestyle advice, else engine order;
 * the fibre card under the protein target.
 */
export function topicSections<S extends Suggestion>(
  sections: ReadonlyArray<{ key: PlanSectionKey; cards: ReadonlyArray<{ category: Suggestion['category']; suggestions: S[] }>; ownershipLine?: string }>,
  forms: { medications: readonly FormSection[]; screenings: readonly FormSection[] },
): TopicLayout<S> {
  const fieldKey = (f: FormField) => (f.kind === 'measurement' ? f.metric : f.key);
  const asked = new Set(forms.medications.flatMap((section) => section.groups.flatMap((g) => g.fields.map(fieldKey))));
  const groups = new Set(forms.screenings.flatMap((section) => section.groups.filter((g) => g.fields.length > 0).map((g) => g.id)));
  const cards = new Map<TopicId, TopicCard<S>[]>();
  const medicines = new Map<string, S[]>();
  const screenings = new Map<string, S[]>();
  const add = <K>(map: Map<K, S[]>, key: K, s: S) => map.set(key, [...(map.get(key) ?? []), s]);
  for (const section of sections) {
    // planSections repeats a skin or supplement suggestion raised to urgent or attention there.
    const repeated = (s: S) => (section.key === 'urgent' || section.key === 'attention') && (s.category === 'skin' || s.category === 'supplements');
    for (const card of section.cards) {
      const byTopic = new Map<TopicId, S[]>();
      for (const s of card.suggestions) {
        if (repeated(s)) continue;
        const key = s.category === 'medication' ? questionKeys(s.id).find((k) => asked.has(k)) : undefined;
        const group = screeningGroupOf(s);
        if (key) add(medicines, key, s);
        else if (group && groups.has(group)) add(screenings, group, s);
        else { add(byTopic, topicOf(s), s); continue; }
        if (s.priority === 'urgent') add(byTopic, topicOf(s), s);
      }
      for (const [topic, suggestions] of byTopic) {
        cards.set(topic, [...(cards.get(topic) ?? []), { category: card.category, priority: highestPriority(suggestions), suggestions }]);
      }
    }
  }
  const ownershipLine = sections.find((section) => section.ownershipLine)?.ownershipLine;
  return {
    sections: TOPICS.filter(({ topic }) => cards.has(topic)).map(({ topic, title }) => ({
      topic, title, cards: ordered(topic, cards.get(topic)!),
      ...(topic === 'supplements' && ownershipLine ? { ownershipLine } : null),
    })),
    medicines: [...medicines].map(([key, suggestions]) => ({ key, suggestions })),
    screenings: [...screenings].map(([group, suggestions]) => ({ group, suggestions })),
  };
}

/** By priority, then a result before advice, else arrival order; in Weight, fibre under the protein target. */
function ordered<S extends Suggestion>(topic: TopicId, cards: TopicCard<S>[]): TopicCard<S>[] {
  const sorted = cards.map((card, i) => ({ card, i }))
    .sort((a, b) => RANK[a.card.priority] - RANK[b.card.priority] || Number(isResult(b.card)) - Number(isResult(a.card)) || a.i - b.i)
    .map(({ card }) => card);
  if (topic !== 'weight') return sorted;
  const isFibre = (s: Suggestion) => s.id === 'fiber';
  const isProtein = (s: Suggestion) => s.id === 'protein-target';
  return after(sorted.map((card) => ({ ...card, suggestions: after(card.suggestions, isFibre, isProtein) })),
    (card) => card.suggestions.length === 1 && isFibre(card.suggestions[0]), (card) => card.suggestions.some(isProtein));
}

/** The list with its `moved` item directly after its `anchor` item, when it holds both. */
function after<T>(list: T[], moved: (item: T) => boolean, anchor: (item: T) => boolean): T[] {
  const item = list.find(moved);
  const rest = list.filter((x) => x !== item);
  const at = rest.findIndex(anchor);
  if (item === undefined || at < 0) return list;
  rest.splice(at + 1, 0, item);
  return rest;
}
