// @vitest-environment jsdom
/**
 * US-61 — a US adult sees Brad's own products on the plan's supplement cards.
 * The overlay is the web half: the engine's cards are unchanged, and the
 * Shopify build alone lays the product blocks, the US card text and the one
 * ownership line over them, for a known adult in the US market.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { calculateHealthResults } from '@roadmap/health-core';
import { US_SUPPLEMENT_DESCRIPTIONS } from '@roadmap/health-core/suggestions';
import { US_SUPPLEMENT_REFERENCES } from '@roadmap/health-core/evidence';
import { US_OWNERSHIP_LINE, US_PRODUCT_LINES } from '@roadmap/health-core/us-products';
import { resolveMarketCountry } from '../lib/market-country';

const mocks = vi.hoisted(() => ({
  trackProductEvent: vi.fn(),
  shopify: { value: true },
  country: { value: 'US' as string | null },
}));
vi.mock('../lib/roadmap-data', () => ({
  getReportHtml: vi.fn(), sendGuestReport: vi.fn(), getReportEmailCaptured: () => false, markReportEmailCaptured: vi.fn(),
}));
vi.mock('../lib/server-api', () => ({ trackABConversion: vi.fn(), trackProductEvent: mocks.trackProductEvent }));
vi.mock('../lib/build-flags', () => ({ get SHOPIFY_SURFACE() { return mocks.shopify.value; }, LOCAL_FIRST: true }));
vi.mock('../lib/market-country', async (original) => ({
  ...await original<typeof import('../lib/market-country')>(),
  getMarketCountry: () => mocks.country.value,
}));
vi.mock('./FeedbackForm', () => ({ FeedbackForm: () => null }));
import { ResultsPanel } from './ResultsPanel';

const YEAR = new Date().getFullYear();
const adult = calculateHealthResults({ heightCm: 175, sex: 'male', weightKg: 80, birthYear: YEAR - 55 });
// A very different adult: the same blocks (AC4).
const otherAdult = calculateHealthResults({ heightCm: 160, sex: 'female', weightKg: 95, birthYear: YEAR - 30, ldlC: 5.2, hba1c: 50 });
const minor = calculateHealthResults({ heightCm: 150, sex: 'female', weightKg: 45, birthYear: YEAR - 10 });
const unknownAge = calculateHealthResults({ heightCm: 175, sex: 'male', weightKg: 80 });

const PRODUCT_CARDS = Object.keys(US_PRODUCT_LINES);
const WHO_SENTENCE = "WHO's 2026 dementia guideline";

function show(results = adult) {
  return render(<ResultsPanel results={results} isValid unitSystem="si" />);
}
function cardById(container: HTMLElement, id: string): HTMLElement {
  const title = adult.suggestions.find((s) => s.id === id)!.title;
  const card = Array.from(container.querySelectorAll<HTMLElement>('.supplements-group .suggestion-card'))
    .find((c) => c.querySelector('.suggestion-title')?.textContent === title);
  if (!card) throw new Error(`no card for ${id}`);
  return card;
}
function blockedCardTitles(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('.us-product'))
    .map((b) => b.closest('.suggestion-card')?.querySelector('.suggestion-title')?.textContent ?? '');
}

/** A controllable IntersectionObserver: nothing is on screen until `reveal()`. */
let observed: { cb: IntersectionObserverCallback; el: Element }[] = [];
class FakeObserver {
  constructor(private cb: IntersectionObserverCallback) {}
  observe(el: Element) { observed.push({ cb: this.cb, el }); }
  disconnect() { observed = observed.filter((o) => o.cb !== this.cb); }
}
function reveal() {
  act(() => {
    for (const { cb, el } of [...observed]) cb([{ isIntersecting: true, target: el } as IntersectionObserverEntry], {} as IntersectionObserver);
  });
}

beforeEach(() => {
  mocks.shopify.value = true;
  mocks.country.value = 'US';
  observed = [];
  vi.stubGlobal('IntersectionObserver', FakeObserver);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe('US-61 AC4/AC5: blocks for a known adult in the US, on the Shopify build', () => {
  it('lays one block on each mapped supplement card, in card order, and none on omega-3 or fiber (AC6)', () => {
    const { container } = show();
    const expected = adult.suggestions.filter((s) => PRODUCT_CARDS.includes(s.id)).map((s) => s.title);
    expect(expected).toHaveLength(6);
    expect(blockedCardTitles(container)).toEqual(expected);
    expect(cardById(container, 'supplement-omega3').querySelector('.us-product')).toBeNull();
    // Fiber sits in the grouped Nutrition card, which the overlay never touches.
    expect(container.querySelector('.grouped-card .us-product')).toBeNull();
  });

  it('each block shows its line and a link to its product with the web UTM tag, in a new tab', () => {
    const { container } = show();
    for (const id of PRODUCT_CARDS) {
      const block = cardById(container, id).querySelector('.us-product')!;
      expect(block.querySelector('.us-product-line')?.textContent).toBe(US_PRODUCT_LINES[id].line);
      const link = block.querySelector('a')!;
      const product = US_PRODUCT_LINES[id].product;
      expect(link.getAttribute('href')).toBe(product === 'sleep'
        ? 'https://microvitamin.com/products/sleep?utm_source=health-tool&utm_medium=web'
        : 'https://microvitamin.com/products/microvitamin-plus?utm_source=health-tool&utm_medium=web');
      expect(link.textContent).toContain(product === 'sleep' ? 'Sleep' : 'MicroVitamin+');
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toBe('noopener');
    }
  });

  it('shows two very different adults the same blocks', () => {
    const first = blockedCardTitles(show(adult).container);
    cleanup();
    expect(blockedCardTitles(show(otherAdult).container)).toEqual(first);
  });

  it.each([
    ['outside the US', () => { mocks.country.value = 'NZ'; }, adult],
    ['with no market country', () => { mocks.country.value = null; }, adult],
    ['for a known minor', () => {}, minor],
    ['for an unknown age', () => {}, unknownAge],
    ['on the GitHub Pages build', () => { mocks.shopify.value = false; }, adult],
  ])('shows no block and no ownership line %s', (_label, setUp, results) => {
    setUp();
    const { container } = show(results);
    expect(container.querySelector('.us-product')).toBeNull();
    expect(container.querySelector('.us-ownership')).toBeNull();
    expect(container.textContent).not.toContain('MicroVitamin+');
    expect(container.textContent).not.toContain(US_OWNERSHIP_LINE);
  });
});

describe('US-61 AC2: the US card text replaces the base text on the US cards only', () => {
  it('base, creatine and lutein show their US text and references; the other cards keep theirs', () => {
    const { container } = show();
    for (const id of ['supplement-micronutrient-base', 'supplement-creatine', 'supplement-lutein-zeaxanthin']) {
      const card = cardById(container, id);
      expect(card.querySelector('.suggestion-desc')?.textContent).toBe(US_SUPPLEMENT_DESCRIPTIONS[`${id}-us`]);
      fireEvent.click(card.querySelector('.evidence-toggle')!);
      const refs = Array.from(card.querySelectorAll('.evidence-refs a')).map((a) => a.getAttribute('href'));
      expect(refs).toEqual(US_SUPPLEMENT_REFERENCES[`${id}-us`].map((r) => r.url));
    }
    expect(cardById(container, 'supplement-micronutrient-base').textContent).not.toContain(WHO_SENTENCE);
    for (const id of ['supplement-collagen', 'supplement-tmg', 'supplement-omega3', 'supplement-sleep']) {
      expect(cardById(container, id).querySelector('.suggestion-desc')?.textContent)
        .toBe(adult.suggestions.find((s) => s.id === id)!.description);
    }
  });

  it('outside the US every card keeps its base text', () => {
    mocks.country.value = 'GB';
    const { container } = show();
    for (const id of ['supplement-micronutrient-base', 'supplement-creatine', 'supplement-lutein-zeaxanthin']) {
      expect(cardById(container, id).querySelector('.suggestion-desc')?.textContent)
        .toBe(adult.suggestions.find((s) => s.id === id)!.description);
    }
    expect(cardById(container, 'supplement-micronutrient-base').textContent).toContain(WHO_SENTENCE);
  });
});

describe('US-61 AC7: one ownership line', () => {
  it('appears once, at the foot of the Supplements section, after its last card', () => {
    const { container } = show();
    const lines = container.querySelectorAll('.us-ownership');
    expect(lines).toHaveLength(1);
    expect(lines[0].textContent).toBe(US_OWNERSHIP_LINE);
    const group = container.querySelector('.supplements-group')!;
    expect(group.lastElementChild).toBe(lines[0]);
    expect(lines[0].previousElementSibling?.classList.contains('suggestion-card')).toBe(true);
  });

  it('the blocks and the line are never printed, on paper or in the PDF clone', () => {
    const { container } = show();
    for (const el of container.querySelectorAll('.us-product, .us-ownership')) expect(el.classList.contains('no-print')).toBe(true);
    const css = readFileSync(resolve(__dirname, '../styles.css'), 'utf8');
    expect(css).toMatch(/@media print\s*\{\s*\.us-product,\s*\.us-ownership\s*\{\s*display:\s*none !important;/);
  });
});

describe('US-61 AC8: the usage signal carries the product alone', () => {
  it('counts each product once the Supplements section comes into view, never before', () => {
    show();
    expect(mocks.trackProductEvent).not.toHaveBeenCalledWith('us_product_shown', expect.anything());
    reveal();
    reveal();
    const shown = mocks.trackProductEvent.mock.calls.filter(([name]) => name === 'us_product_shown');
    expect(shown).toEqual([
      ['us_product_shown', { product: 'microvitamin_plus' }],
      ['us_product_shown', { product: 'sleep' }],
    ]);
  });

  it('counts a click with the product alone', () => {
    const { container } = show();
    fireEvent.click(cardById(container, 'supplement-sleep').querySelector('.us-product a')!);
    fireEvent.click(cardById(container, 'supplement-tmg').querySelector('.us-product a')!);
    const clicks = mocks.trackProductEvent.mock.calls.filter(([name]) => name === 'us_product_link_clicked');
    expect(clicks).toEqual([
      ['us_product_link_clicked', { product: 'sleep' }],
      ['us_product_link_clicked', { product: 'microvitamin_plus' }],
    ]);
  });

  it('sends nothing outside the US', () => {
    mocks.country.value = 'AU';
    show();
    reveal();
    expect(mocks.trackProductEvent.mock.calls.filter(([name]) => String(name).startsWith('us_product'))).toEqual([]);
  });
});

describe('US-61 AC5: the market country from the app block', () => {
  function root(country?: string) {
    const el = document.createElement('div');
    if (country !== undefined) el.dataset.country = country;
    return el;
  }
  it('takes a two-letter code and ignores anything else', () => {
    expect(resolveMarketCountry(root('US'))).toBe('US');
    expect(resolveMarketCountry(root(' us '))).toBe('US');
    for (const bad of ['', 'USA', 'U', '12', '<US>', 'U S']) expect(resolveMarketCountry(root(bad))).toBeNull();
    expect(resolveMarketCountry(root())).toBeNull();
    expect(resolveMarketCountry(null)).toBeNull();
  });

  it('the app block passes Shopify\'s market country to the widget root', () => {
    const liquid = readFileSync(resolve(__dirname, '../../../extensions/health-tool-widget/blocks/app-block.liquid'), 'utf8');
    const rootTag = liquid.slice(liquid.indexOf('id="health-tool-root"'));
    expect(rootTag.slice(0, rootTag.indexOf('\n>'))).toContain('data-country="{{ localization.country.iso_code | escape }}"');
  });
});
