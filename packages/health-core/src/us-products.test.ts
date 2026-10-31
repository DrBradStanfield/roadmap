/**
 * US-61: the two new supplement cards, the US variants, and the US product
 * overlay. The engine stays product-free in every country; only the overlay
 * (us-products.ts) names a product.
 */
import { describe, it, expect } from 'vitest';
import { generateSuggestions, medicinesShown, US_SUPPLEMENT_DESCRIPTIONS } from './suggestions';
import { SUGGESTION_EVIDENCE, US_SUPPLEMENT_REFERENCES } from './evidence';
import { calculateHealthResults } from './calculations';
import { createEmptyFile } from './roadmap-file';
import { computePlan, renderJson } from './plan';
import { usProductBlocks, usProductUrl, US_OWNERSHIP_LINE, US_PRODUCT_LINES } from './us-products';
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
const PRODUCT_TEXT = /microvitamin|sleep by|drstanfield|dr brad|-us\b/i;

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
    ]);
    const tmg = suggestions.find((s) => s.id === 'supplement-tmg')!;
    expect(tmg).toMatchObject({ category: 'supplements', priority: 'info', title: 'TMG (trimethylglycine)' });
    expect(tmg.description).toBe('TMG lowers blood homocysteine, according to a meta-analysis of randomized trials. Small trials suggest it may improve strength and power. At the higher doses used in these trials, it slightly raised total cholesterol.');
    expect(tmg.references!.map((r) => r.label.split(' ')[0])).toEqual(['McRae', 'Lee', 'Pryor', 'Nobari', 'Zawieja']);
    expect(tmg.references!.at(-1)!.url).toBe('https://doi.org/10.1080/19390211.2019.1699223');
  });

  it('US-61 AC1: the lutein card never says adding lutein and zeaxanthin did not slow progression (Brad\'s AREDS2 framing)', () => {
    const text = `${plan(adult).suggestions.find((s) => s.id === 'supplement-lutein-zeaxanthin')!.description} ${SUGGESTION_EVIDENCE['supplement-lutein-zeaxanthin'].reason}`;
    expect(text).not.toMatch(/did not (significantly )?slow/i);
    expect(SUGGESTION_EVIDENCE['supplement-tmg'].reason).not.toMatch(/dementia|alzheimer/i);
    expect(SUGGESTION_EVIDENCE['supplement-lutein-zeaxanthin'].reason).toContain('slowed the progression of macular degeneration in people with intermediate macular degeneration');
  });

  it('US-61 AC1: a known minor gets neither new card (adults only, like every supplement card)', () => {
    const ids = plan(minor).suggestions.map((s) => s.id);
    expect(ids).toEqual(['adults-only']);
  });
});

describe('US-61 AC2-AC3: engine output never carries a product or a US variant, in any country', () => {
  it('US-61 AC3: generateSuggestions emits no -us id and no product name, for a US-like conventional-units adult', () => {
    for (const record of [adult, other]) {
      const { suggestions } = plan(record, 'conventional');
      expect(suggestions.some((s) => s.id.endsWith('-us'))).toBe(false);
      const supplements = suggestions.filter((s) => s.category === 'supplements');
      expect(supplements.map((s) => `${s.title} ${s.description} ${JSON.stringify(s.references)}`).join(' ')).not.toMatch(PRODUCT_TEXT);
      // The base card keeps the WHO sentences: the variant is the overlay's alone.
      expect(supplements.find((s) => s.id === 'supplement-micronutrient-base')!.description).toContain('WHO');
    }
  });

  // No runRoadmap or chat-context test here: the chat context (runRoadmap's
  // contextJson) never holds supplement text, so a check on it proves nothing.
  it('US-61 AC3: get_plan and the CLI (renderJson of computePlan) carry the generic supplement cards, with no product name and no -us text', () => {
    const file = createEmptyFile({ deviceId: 'dev_us', now: '2026-10-01T00:00:00Z' });
    file.profile = { sex: 'male', heightCm: 178, birthYear: 1970, unitSystem: 'conventional', updatedAt: '2026-10-01T00:00:00Z', lamport: 1 };
    const json = renderJson(computePlan(file, NOW));
    for (const id of Object.keys(US_PRODUCT_LINES)) expect(json).toContain(`"${id}"`);
    expect(json).not.toMatch(PRODUCT_TEXT);
    expect(json).not.toContain(US_SUPPLEMENT_DESCRIPTIONS['supplement-creatine-us'] + '"');
    expect(json).not.toContain(US_SUPPLEMENT_DESCRIPTIONS['supplement-lutein-zeaxanthin-us'] + '"');
  });

  it('US-61 AC3: each variant is its card\'s text minus what it drops, with no product name', () => {
    const { suggestions } = plan(adult);
    const card = (id: string) => suggestions.find((s) => s.id === id)!;
    const base = US_SUPPLEMENT_DESCRIPTIONS['supplement-micronutrient-base-us'];
    expect(base).not.toMatch(/WHO|dementia/);
    expect(base).toContain('COSMOS');
    expect(base).toContain('warfarin');
    expect(card('supplement-micronutrient-base').description.startsWith(base.split(' If you take')[0])).toBe(true);
    expect(US_SUPPLEMENT_DESCRIPTIONS['supplement-creatine-us']).toBe('One of the most-studied supplements: a meta-analysis found creatine (3–5 g/day) significantly increases muscle strength and lean mass with resistance training.');
    expect(US_SUPPLEMENT_DESCRIPTIONS['supplement-lutein-zeaxanthin-us']).toBe('Lutein and zeaxanthin are the pigments of the macula, the part of the eye that sees fine detail. Trials show supplements raise macular pigment density.');
    expect(Object.values(US_SUPPLEMENT_DESCRIPTIONS).join(' ')).not.toMatch(PRODUCT_TEXT);
    expect(US_SUPPLEMENT_REFERENCES['supplement-micronutrient-base-us'].map((r) => r.label)).not.toContainEqual(expect.stringMatching(/WHO/));
    expect(US_SUPPLEMENT_REFERENCES['supplement-creatine-us'].map((r) => r.label.split(' ')[0])).toEqual(['Kreider']);
    expect(US_SUPPLEMENT_REFERENCES['supplement-lutein-zeaxanthin-us'].map((r) => r.label)).not.toContainEqual(expect.stringMatching(/AREDS|macular degeneration/i));
    expect(Object.keys(US_SUPPLEMENT_REFERENCES).sort()).toEqual(Object.keys(US_SUPPLEMENT_DESCRIPTIONS).sort());
  });
});

describe('US-61 AC4-AC6: usProductBlocks', () => {
  const blocksFor = (inputs: HealthInputs, isUS = true) => {
    const { results, suggestions } = plan(inputs);
    return usProductBlocks(suggestions, medicinesShown(results), isUS, 'web');
  };

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

  it('US-61 AC4: the three variant cards carry their US text and references; the others carry none', () => {
    const { blocks } = blocksFor(adult);
    const withText = blocks.filter((b) => b.description).map((b) => b.suggestionId);
    expect(withText).toEqual(['supplement-micronutrient-base', 'supplement-creatine', 'supplement-lutein-zeaxanthin']);
    for (const b of blocks.filter((x) => x.description)) {
      expect(b.description).toBe(US_SUPPLEMENT_DESCRIPTIONS[`${b.suggestionId}-us`]);
      expect(b.references).toEqual(US_SUPPLEMENT_REFERENCES[`${b.suggestionId}-us`]);
    }
    expect(blocks.find((b) => b.suggestionId === 'supplement-tmg')).not.toHaveProperty('description');
  });

  it('US-61 AC5: none for a known minor, an unknown age, or outside the US', () => {
    const empty = { blocks: [], ownershipLine: null };
    expect(blocksFor(minor)).toEqual(empty);
    expect(blocksFor(noAge)).toEqual(empty);
    expect(blocksFor(adult, false)).toEqual(empty);
  });

  it('US-61 AC6: fiber and omega-3 get no product', () => {
    const { blocks } = usProductBlocks([{ id: 'fiber' }, { id: 'supplement-omega3' }], true, true, 'web');
    expect(blocks).toEqual([]);
    expect(Object.keys(US_PRODUCT_LINES)).not.toContain('fiber');
    expect(Object.keys(US_PRODUCT_LINES)).not.toContain('supplement-omega3');
  });

  it('US-61 AC8: the links carry utm_source=health-tool and the medium, web or ios', () => {
    expect(usProductUrl('microvitamin_plus', 'web')).toBe('https://microvitamin.com/products/microvitamin-plus?utm_source=health-tool&utm_medium=web');
    expect(usProductUrl('sleep', 'ios')).toBe('https://microvitamin.com/products/sleep?utm_source=health-tool&utm_medium=ios');
    const { results, suggestions } = plan(adult);
    const ios = usProductBlocks(suggestions, medicinesShown(results), true, 'ios');
    expect(ios.blocks.every((b) => b.url.endsWith('?utm_source=health-tool&utm_medium=ios'))).toBe(true);
    expect(ios.ownershipLine).toBe(US_OWNERSHIP_LINE);
  });
});
