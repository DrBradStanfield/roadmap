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
import type { Suggestion, SuggestionReference } from './types';
import { US_SUPPLEMENT_DESCRIPTIONS } from './suggestions';
import { US_SUPPLEMENT_REFERENCES } from './evidence';

export type UsProduct = 'microvitamin_plus' | 'sleep';
export type UsProductMedium = 'web' | 'ios';

export const US_PRODUCTS: Readonly<Record<UsProduct, { name: string; url: string }>> = {
  microvitamin_plus: { name: 'MicroVitamin+', url: 'https://microvitamin.com/products/microvitamin-plus' },
  sleep: { name: 'Sleep', url: 'https://microvitamin.com/products/sleep' },
};

/** Card id → its product and line (Brad's final text, 2026-10-31). Fiber and omega-3 get none. */
export const US_PRODUCT_LINES: Readonly<Record<string, { product: UsProduct; line: string }>> = {
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
  'supplement-tmg': { product: 'microvitamin_plus', line: 'MicroVitamin+ contains 500 mg of TMG, a lower dose than these trials used.' },
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

export interface UsProductBlock {
  /** The engine card this block sits on. */
  suggestionId: string;
  product: UsProduct;
  name: string;
  line: string;
  url: string;
  /** The card's US text, when it has a variant: show it in place of the card's description. */
  description?: string;
  /** The card's US references, with the description: show them in place of the card's. */
  references?: SuggestionReference[];
}

export interface UsProductOverlay {
  /** In the order the cards came. Empty when nothing shows. */
  blocks: UsProductBlock[];
  /** US_OWNERSHIP_LINE when any block shows, else null. */
  ownershipLine: string | null;
}

/**
 * What the US overlay shows on these cards (US-61 AC4–AC6). Nothing unless the
 * viewer is a known adult (pass `medicinesShown(results)`) in the US (web:
 * Liquid's market country; iPhone: App Store storefront USA). The blocks
 * depend only on which cards are present, never on a health value.
 */
export function usProductBlocks(
  suggestions: ReadonlyArray<Pick<Suggestion, 'id'>>,
  isKnownAdult: boolean,
  isUS: boolean,
  medium: UsProductMedium,
): UsProductOverlay {
  if (!isKnownAdult || !isUS) return { blocks: [], ownershipLine: null };
  const blocks: UsProductBlock[] = [];
  for (const { id } of suggestions) {
    const entry = US_PRODUCT_LINES[id];
    if (!entry) continue;
    const description = US_SUPPLEMENT_DESCRIPTIONS[`${id}-us`];
    blocks.push({
      suggestionId: id,
      product: entry.product,
      name: US_PRODUCTS[entry.product].name,
      line: entry.line,
      url: usProductUrl(entry.product, medium),
      ...(description ? { description, references: US_SUPPLEMENT_REFERENCES[`${id}-us`] } : {}),
    });
  }
  return { blocks, ownershipLine: blocks.length > 0 ? US_OWNERSHIP_LINE : null };
}
