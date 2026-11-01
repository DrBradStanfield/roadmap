/**
 * US-61: the two new supplement cards, the US variants, and the US product
 * overlay. The engine stays product-free in every country; only the overlay
 * (us-products.ts) names a product.
 */
import { describe, it, expect } from 'vitest';
import { generateSuggestions, US_SUPPLEMENT_DESCRIPTIONS } from './suggestions';
import { SUGGESTION_EVIDENCE, US_SUPPLEMENT_REFERENCES } from './evidence';
import { calculateHealthResults } from './calculations';
import { createEmptyFile } from './roadmap-file';
import { computePlan, renderJson } from './plan';
import { planSections, type PlanSection } from './plan-sections';
import { usProductSections, usProductUrl, US_OWNERSHIP_LINE, US_PRODUCT_LINES, type UsPlanSection } from './us-products';
import type { HealthInputs } from './types';

const NOW = new Date('2026-10-31T12:00:00Z');
const SUPPLEMENT_IDS = [
  'supplement-micronutrient-base',
  'supplement-creatine',
  'supplement-collagen',
  'supplement-lutein-zeaxanthin',
  'supplement-tmg',
  'supplement-omega3',
  'supplement-sleep',
];

function plan(inputs: HealthInputs, unitSystem: 'si' | 'conventional' = 'si') {
  const results = calculateHealthResults(inputs, unitSystem, undefined, undefined, undefined, NOW);
  return { results, suggestions: generateSuggestions(inputs, results, unitSystem) };
}
const adult: HealthInputs = { sex: 'male', heightCm: 178, weightKg: 80, birthYear: 1970, birthMonth: 5 };
// A very different adult: older woman, raised lipids, high BP, conventional units.
const other: HealthInputs = {
  sex: 'female', heightCm: 160, weightKg: 92, waistCm: 104, birthYear: 1950, birthMonth: 1,
  ldlC: 4.9, triglycerides: 2.6, hba1c: 50, systolicBp: 152, diastolicBp: 94,
};
const minor: HealthInputs = { sex: 'female', heightCm: 160, weightKg: 55, birthYear: 2012, birthMonth: 1 };
const noAge: HealthInputs = { sex: 'male', heightCm: 178, weightKg: 80 };
const PRODUCT_TEXT = /microvitamin|sleep by|drstanfield|dr brad/i;

describe('US-61 AC1: the two new supplement cards, in every market', () => {
  it('US-61 AC1: an adult gets lutein and zeaxanthin and TMG, beside the other supplement cards, with the final text', () => {
    const { suggestions } = plan(adult);
    expect(suggestions.filter((s) => s.category === 'supplements').map((s) => s.id)).toEqual(SUPPLEMENT_IDS);
    const lutein = suggestions.find((s) => s.id === 'supplement-lutein-zeaxanthin')!;
    expect(lutein).toMatchObject({ category: 'supplements', priority: 'info', title: 'Lutein and zeaxanthin' });
    expect(lutein.description).toBe('Lutein and zeaxanthin are the pigments of the macula, the part of the eye that sees fine detail. Trials show supplements raise macular pigment density. In the AREDS trial, a formula containing beta-carotene slowed the progression of macular degeneration. In AREDS2, lutein and zeaxanthin worked as well as beta-carotene, without beta-carotene\'s lung cancer signal in former smokers.');
    expect(lutein.references!.map((r) => r.url)).toEqual([
      'https://doi.org/10.1093/advances/nmab071',
      'https://doi.org/10.1001/archopht.119.10.1417',
      'https://doi.org/10.1001/jama.2013.4997',
      'https://doi.org/10.1001/jamaophthalmol.2022.1640',
    ]);
    const tmg = suggestions.find((s) => s.id === 'supplement-tmg')!;
    expect(tmg).toMatchObject({ category: 'supplements', priority: 'info', title: 'TMG (trimethylglycine)' });
    expect(tmg.description).toBe('TMG lowers blood homocysteine, according to a meta-analysis of randomized trials. Small trials suggest it may improve strength and power.');
    expect(tmg.references!.map((r) => r.label.split(' ')[0])).toEqual(['McRae', 'Lee', 'Pryor', 'Nobari']);
    expect(tmg.references!.at(-1)!.url).toBe('https://doi.org/10.1186/s12970-021-00464-y');
  });

  it('US-61 AC1: the lutein card never says adding lutein and zeaxanthin did not slow progression (Brad\'s AREDS2 framing)', () => {
    const text = `${plan(adult).suggestions.find((s) => s.id === 'supplement-lutein-zeaxanthin')!.description} ${SUGGESTION_EVIDENCE['supplement-lutein-zeaxanthin'].reason}`;
    expect(text).not.toMatch(/did not (significantly )?slow/i);
    expect(SUGGESTION_EVIDENCE['supplement-tmg'].reason).not.toMatch(/dementia|alzheimer/i);
    // Brad 2026-11-01: no cholesterol line and no dose caveat for TMG.
    expect(SUGGESTION_EVIDENCE['supplement-tmg'].reason).not.toMatch(/cholesterol/i);
    expect(US_PRODUCT_LINES['supplement-tmg'].line).toBe('MicroVitamin+ contains 500 mg of TMG.');
    expect(SUGGESTION_EVIDENCE['supplement-lutein-zeaxanthin'].reason).toContain('slowed progression in people with intermediate macular degeneration, or advanced disease in one eye');
  });

  it('US-61 AC1: a known minor gets neither new card (adults only, like every supplement card)', () => {
    const ids = plan(minor).suggestions.map((s) => s.id);
    expect(ids).toEqual(['adults-only']);
  });
});

describe('US-61 AC2-AC3: engine output never carries a product or a US variant, in any country', () => {
  it('US-61 AC3: generateSuggestions emits no US text and no product name, for a US-like conventional-units adult', () => {
    for (const record of [adult, other]) {
      const { suggestions } = plan(record, 'conventional');
      expect(suggestions.map((s) => s.description)).not.toContain(US_SUPPLEMENT_DESCRIPTIONS['supplement-creatine']);
      const supplements = suggestions.filter((s) => s.category === 'supplements');
      expect(supplements.map((s) => `${s.title} ${s.description} ${JSON.stringify(s.references)}`).join(' ')).not.toMatch(PRODUCT_TEXT);
      // The base card keeps the WHO sentences: the variant is the overlay's alone.
      expect(supplements.find((s) => s.id === 'supplement-micronutrient-base')!.description).toContain('WHO');
    }
  });

  // No runRoadmap or chat-context test here: the chat context (runRoadmap's
  // contextJson) never holds supplement text, so a check on it proves nothing.
  it('US-61 AC3: get_plan and the CLI (renderJson of computePlan) carry the generic supplement cards, with no product name and no US text', () => {
    const file = createEmptyFile({ deviceId: 'dev_us', now: '2026-10-01T00:00:00Z' });
    file.profile = { sex: 'male', heightCm: 178, birthYear: 1970, unitSystem: 'conventional', updatedAt: '2026-10-01T00:00:00Z', lamport: 1 };
    const json = renderJson(computePlan(file, NOW));
    for (const id of Object.keys(US_PRODUCT_LINES)) expect(json).toContain(`"${id}"`);
    expect(json).not.toMatch(PRODUCT_TEXT);
    for (const text of Object.values(US_SUPPLEMENT_DESCRIPTIONS)) expect(json).not.toContain(text + '"');
  });

  it('US-61 AC3: no generated card ever carries a US variant as its text', () => {
    const descriptions = plan(adult).suggestions.map((s) => s.description);
    for (const text of Object.values(US_SUPPLEMENT_DESCRIPTIONS)) expect(descriptions).not.toContain(text);
  });

  it('US-61 AC4: a grouped Supplements card takes no block (single cards only, as the web draws them)', () => {
    const { results, suggestions } = plan(adult);
    const sections = planSections(suggestions);
    const supp = sections.find((s) => s.key === 'supplements')!;
    const grouped: PlanSection[] = sections.map((s) => s === supp ? { ...s, cards: [{ ...supp.cards[0], suggestions: [supp.cards[0].suggestions[0], supp.cards[1].suggestions[0]] }, ...supp.cards.slice(2)] } : s);
    const overlaid = usProductSections(grouped, results, true, 'web')!;
    const groupedCard = overlaid.find((s) => s.key === 'supplements')!.cards[0];
    expect(groupedCard.suggestions.every((s) => !('usProduct' in s) || !s.usProduct)).toBe(true);
    expect(overlaid.find((s) => s.key === 'supplements')!.cards.slice(1).some((c) => c.suggestions[0].usProduct)).toBe(true);
  });

  it('US-61 AC3: each variant is its card\'s text minus what it drops, with no product name', () => {
    const { suggestions } = plan(adult);
    const card = (id: string) => suggestions.find((s) => s.id === id)!;
    const base = US_SUPPLEMENT_DESCRIPTIONS['supplement-micronutrient-base']!;
    expect(base).not.toMatch(/WHO|dementia/);
    expect(base).toContain('COSMOS');
    expect(base).toContain('warfarin');
    expect(card('supplement-micronutrient-base').description.startsWith(base.split(' If you take')[0])).toBe(true);
    expect(US_SUPPLEMENT_DESCRIPTIONS['supplement-creatine']!).toBe('One of the most-studied supplements: a meta-analysis found creatine (3–5 g/day) significantly increases muscle strength and lean mass with resistance training.');
    expect(US_SUPPLEMENT_DESCRIPTIONS['supplement-lutein-zeaxanthin']!).toBe('Lutein and zeaxanthin are the pigments of the macula, the part of the eye that sees fine detail. Trials show supplements raise macular pigment density.');
    expect(Object.values(US_SUPPLEMENT_DESCRIPTIONS).join(' ')).not.toMatch(PRODUCT_TEXT);
    expect(US_SUPPLEMENT_REFERENCES['supplement-micronutrient-base']!.map((r) => r.label)).not.toContainEqual(expect.stringMatching(/WHO/));
    expect(US_SUPPLEMENT_REFERENCES['supplement-creatine']!.map((r) => r.label.split(' ')[0])).toEqual(['Kreider']);
    expect(US_SUPPLEMENT_REFERENCES['supplement-lutein-zeaxanthin']!.map((r) => r.label)).not.toContainEqual(expect.stringMatching(/AREDS|macular degeneration/i));
    expect(Object.keys(US_SUPPLEMENT_REFERENCES).sort()).toEqual(Object.keys(US_SUPPLEMENT_DESCRIPTIONS).sort());
  });
});

/** What the overlay shows, flat: each block with its card id, and the line. */
function shownOf(overlaid: UsPlanSection[] | null) {
  const cards = (overlaid ?? []).flatMap((section) => section.cards.flatMap((c) => c.suggestions));
  return {
    blocks: cards.filter((s) => s.usProduct).map((s) => ({ suggestionId: s.id, ...s.usProduct! })),
    ownershipLine: overlaid?.find((section) => section.ownershipLine)?.ownershipLine ?? null,
  };
}

describe('US-61 AC4-AC7: usProductSections', () => {
  const overlayFor = (inputs: HealthInputs, isUS = true, medium: 'web' | 'ios' = 'web') => {
    const { results, suggestions } = plan(inputs);
    return { sections: planSections(suggestions), overlaid: usProductSections(planSections(suggestions), results, isUS, medium) };
  };
  const blocksFor = (inputs: HealthInputs, isUS = true) => shownOf(overlayFor(inputs, isUS).overlaid);

  it('US-61 AC4: two very different adults get the same blocks, in card order, with the final lines', () => {
    const a = blocksFor(adult);
    expect(blocksFor(other)).toEqual(a);
    expect(a.blocks.map((b) => [b.suggestionId, b.product])).toEqual([
      ['supplement-micronutrient-base', 'microvitamin_plus'],
      ['supplement-creatine', 'microvitamin_plus'],
      ['supplement-collagen', 'microvitamin_plus'],
      ['supplement-lutein-zeaxanthin', 'microvitamin_plus'],
      ['supplement-tmg', 'microvitamin_plus'],
      ['supplement-sleep', 'sleep'],
    ]);
    expect(a.blocks.find((b) => b.suggestionId === 'supplement-sleep')).toMatchObject({
      name: 'Sleep',
      line: 'Sleep contains 0.8 mg of sustained-release melatonin, 2,400 mg of glycine and magnesium bisglycinate.',
      url: 'https://microvitamin.com/products/sleep?utm_source=health-tool&utm_medium=web',
    });
    expect(a.ownershipLine).toBe('Brad Stanfield founded and owns the company that sells MicroVitamin+ and Sleep.');
  });

  it('US-61 AC2/AC4: the three variant cards carry their US text and references; the others keep their own', () => {
    const { sections, overlaid } = overlayFor(adult);
    const own = sections.flatMap((section) => section.cards.flatMap((c) => c.suggestions));
    const shown = overlaid!.flatMap((section) => section.cards.flatMap((c) => c.suggestions));
    const swapped = shown.filter((s, i) => s.description !== own[i].description).map((s) => s.id);
    expect(swapped).toEqual(['supplement-micronutrient-base', 'supplement-creatine', 'supplement-lutein-zeaxanthin']);
    for (const id of swapped as (keyof typeof US_SUPPLEMENT_DESCRIPTIONS)[]) {
      const s = shown.find((x) => x.id === id)!;
      expect(s.description).toBe(US_SUPPLEMENT_DESCRIPTIONS[id]);
      expect(s.references).toEqual(US_SUPPLEMENT_REFERENCES[id]);
    }
    const tmg = shown.find((s) => s.id === 'supplement-tmg')!;
    expect(tmg.references).toEqual(own.find((s) => s.id === 'supplement-tmg')!.references);
    // The input sections are never changed.
    expect(sections).toEqual(planSections(plan(adult).suggestions));
  });

  it('US-61 AC5: none for a known minor, an unknown age, or outside the US', () => {
    expect(overlayFor(minor).overlaid).toBeNull();
    expect(overlayFor(noAge).overlaid).toBeNull();
    expect(overlayFor(adult, false).overlaid).toBeNull();
  });

  it('US-61 AC5: the adult gate is the overlay\'s own, from the results (medicinesShown)', () => {
    const { suggestions } = plan(adult);
    const sections = planSections(suggestions);
    expect(usProductSections(sections, { age: 15, knownMinor: true }, true, 'web')).toBeNull();
    expect(usProductSections(sections, { age: undefined }, true, 'web')).toBeNull();
    expect(usProductSections(sections, { age: 40 }, true, 'web')).not.toBeNull();
  });

  it('US-61 AC6: fiber and omega-3 get no product', () => {
    const results = plan(adult).results;
    const card = (id: string) => ({ category: 'supplements' as const, priority: 'info' as const, suggestions: [{ id, category: 'supplements' as const, priority: 'info' as const, title: 'T', description: 'D' }] });
    const sections: PlanSection[] = [{ key: 'supplements', title: 'Supplements', cards: [card('fiber'), card('supplement-omega3')] }];
    expect(usProductSections(sections, results, true, 'web')).toBeNull();
    expect(Object.keys(US_PRODUCT_LINES)).not.toContain('fiber');
    expect(Object.keys(US_PRODUCT_LINES)).not.toContain('supplement-omega3');
  });

  it('US-61 AC7: blocks and the one ownership line sit on the Supplements section only', () => {
    const { results, suggestions } = plan(adult);
    const sleep = suggestions.find((s) => s.id === 'supplement-sleep')!;
    // A mapped card outside the Supplements section takes nothing.
    const sections: PlanSection[] = [
      { key: 'info', title: 'Foundation', cards: [{ category: 'supplements', priority: 'info', suggestions: [sleep] }] },
      ...planSections(suggestions),
    ];
    const overlaid = usProductSections(sections, results, true, 'web')!;
    expect(overlaid[0]).toBe(sections[0]);
    expect(overlaid.filter((section) => section.ownershipLine).map((section) => section.key)).toEqual(['supplements']);
    expect(overlaid.filter((section) => section.key !== 'supplements').flatMap((section) => section.cards.flatMap((c) => c.suggestions)).some((s) => s.usProduct)).toBe(false);
  });

  it('US-61 AC8: the links carry utm_source=health-tool and the medium, web or ios', () => {
    expect(usProductUrl('microvitamin_plus', 'web')).toBe('https://microvitamin.com/products/microvitamin-plus?utm_source=health-tool&utm_medium=web');
    expect(usProductUrl('sleep', 'ios')).toBe('https://microvitamin.com/products/sleep?utm_source=health-tool&utm_medium=ios');
    const ios = shownOf(overlayFor(adult, true, 'ios').overlaid);
    expect(ios.blocks.every((b) => b.url.endsWith('?utm_source=health-tool&utm_medium=ios'))).toBe(true);
    expect(ios.ownershipLine).toBe(US_OWNERSHIP_LINE);
  });
});
