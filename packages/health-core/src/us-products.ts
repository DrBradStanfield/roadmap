/**
 * US-61: Brad's own products on the US version of the plan's supplement cards.
 *
 * The engine (generateSuggestions, runRoadmap, get_plan, the CLI, the chat
 * context) never reads this file: it emits the same generic cards in every
 * country. Only the screen overlays a product block, on the Shopify web build
 * and the iPhone app, for a known adult in the US. Import this module by path,
 * and only under SHOPIFY_SURFACE on the web, so the GitHub Pages bundle carries
 * no product name. Not exported from index.ts for that reason.
 *
 * Pure and JSON-shaped, so the iPhone's engine bundle can call it too.
 */
import type { HealthResults, Suggestion, UsProductCardId } from './types';
import type { PlanCard, PlanSection } from './plan-sections';
import { medicinesShown, US_SUPPLEMENT_DESCRIPTIONS } from './suggestions';
import { US_SUPPLEMENT_REFERENCES } from './evidence';

export type UsProduct = 'microvitamin_plus' | 'sleep';
export type UsProductMedium = 'web' | 'ios';

export const US_PRODUCTS: Readonly<Record<UsProduct, { name: string; url: string }>> = {
  microvitamin_plus: { name: 'MicroVitamin+', url: 'https://microvitamin.com/products/microvitamin-plus' },
  sleep: { name: 'Sleep', url: 'https://microvitamin.com/products/sleep' },
};

/** Card id → its product and line (Brad's final text, 2026-10-31). Fiber and omega-3 get none. */
export const US_PRODUCT_LINES: Readonly<Record<UsProductCardId, { product: UsProduct; line: string }>> = {
  'supplement-micronutrient-base': {
    product: 'microvitamin_plus',
    line: 'COSMOS tested a standard multivitamin (Centrum Silver), not MicroVitamin+. It is the trial that led Dr Brad to create MicroVitamin+, which uses doses close to daily needs rather than megadoses.',
  },
  'supplement-creatine': { product: 'microvitamin_plus', line: 'MicroVitamin+ contains 5 g of creatine monohydrate.' },
  'supplement-collagen': { product: 'microvitamin_plus', line: 'MicroVitamin+ contains 12.5 g of collagen peptides.' },
  'supplement-lutein-zeaxanthin': {
    product: 'microvitamin_plus',
    line: 'MicroVitamin+ contains 10 mg of lutein and 2 mg of zeaxanthin, the doses used in the AREDS2 trial.',
  },
  'supplement-tmg': { product: 'microvitamin_plus', line: 'MicroVitamin+ contains 500 mg of TMG.' },
  'supplement-sleep': {
    product: 'sleep',
    line: 'Sleep contains 0.8 mg of sustained-release melatonin, 2,400 mg of glycine and magnesium bisglycinate.',
  },
};

/** Shown once, under the last Supplements card, whenever any block shows. */
export const US_OWNERSHIP_LINE = 'Brad Stanfield founded and owns the company that sells MicroVitamin+ and Sleep.';

/** The product page with the tool's UTM tag. */
export function usProductUrl(product: UsProduct, medium: UsProductMedium): string {
  return `${US_PRODUCTS[product].url}?utm_source=health-tool&utm_medium=${medium}`;
}

/** Dr Brad's product on one card. */
export interface UsProductBlock {
  product: UsProduct;
  name: string;
  line: string;
  url: string;
}

/** A card's suggestion with its US text and references in place, and its block. */
export type UsSuggestion = Suggestion & { usProduct?: UsProductBlock };
export type UsPlanCard = Omit<PlanCard, 'suggestions'> & { suggestions: UsSuggestion[] };
/** A section; `ownershipLine` is US_OWNERSHIP_LINE on the Supplements section when it shows a block. */
export type UsPlanSection = Omit<PlanSection, 'cards'> & { cards: UsPlanCard[]; ownershipLine?: string };

function isProductCard(id: string): id is UsProductCardId {
  return Object.prototype.hasOwnProperty.call(US_PRODUCT_LINES, id);
}

function withProduct(s: Suggestion, medium: UsProductMedium): UsSuggestion {
  if (!isProductCard(s.id)) return s;
  const { product, line } = US_PRODUCT_LINES[s.id];
  const description = US_SUPPLEMENT_DESCRIPTIONS[s.id];
  return {
    ...s,
    ...(description ? { description, references: US_SUPPLEMENT_REFERENCES[s.id] } : {}),
    usProduct: { product, name: US_PRODUCTS[product].name, line, url: usProductUrl(product, medium) },
  };
}

/**
 * planSections' layout as the US overlay shows it (US-61 AC2, AC4–AC7), the one
 * place that decides it: on the Supplements section only, each mapped card takes
 * its block and its US text and references when it has them, and the section
 * takes the ownership line. Null when nothing shows, so the caller draws the
 * sections as they are: blocks show only to a known adult (medicinesShown,
 * checked here) in the US (web: Liquid's market country; iPhone: App Store
 * storefront USA). They depend only on which cards are present, never on a
 * health value.
 */
export function usProductSections(
  sections: readonly PlanSection[],
  results: Pick<HealthResults, 'age' | 'knownMinor'>,
  isUS: boolean,
  medium: UsProductMedium,
): UsPlanSection[] | null {
  if (!isUS || !medicinesShown(results)) return null;
  let shown = false;
  const overlaid = sections.map((section): UsPlanSection => {
    if (section.key !== 'supplements') return section;
    // Single cards only: a grouped card has no block to draw on the web.
    const cards = section.cards.map((card) => card.suggestions.length === 1 ? { ...card, suggestions: [withProduct(card.suggestions[0], medium)] } : card);
    if (!cards.some((c) => c.suggestions.some((s) => s.usProduct))) return section;
    shown = true;
    return { ...section, cards, ownershipLine: US_OWNERSHIP_LINE };
  });
  return shown ? overlaid : null;
}
