// US-61 AC4, AC5, AC7, AC8 on the iPhone: screenJson carries health-core's own US overlay
// (us-products.ts) beside the plan, for a known adult on a US App Store storefront only:
// the sections ready to draw. The plain sections stay the web's planSections, product-free.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { US_SUPPLEMENT_DESCRIPTIONS } from '../../packages/health-core/src/suggestions';
import { US_SUPPLEMENT_REFERENCES } from '../../packages/health-core/src/evidence';
import { planSections } from '../../packages/health-core/src/plan-sections';
import { computePlan } from '../../packages/health-core/src/plan';
import { US_OWNERSHIP_LINE, usProductSections, type UsPlanSection } from '../../packages/health-core/src/us-products';
import type { RoadmapFile } from '../../packages/health-core/src/roadmap-file';
import { applyEdit, newRecord, readRecord } from './my-data';
import { screenJson } from './entry';

const NOW = '2026-10-21T08:00:00.000Z';
const sample = readFileSync(join(__dirname, '../../docs/examples/health-roadmap.sample.json'), 'utf8');

function record(profile: { birthYear?: number; birthMonth?: number }): string {
  const outcome = applyEdit(newRecord(NOW, 'phone', 'en-NZ', 'Pacific/Auckland') as RoadmapFile,
    { kind: 'profile', sex: 'male', height: 180, ...profile }, NOW);
  if (!outcome.ok) throw new Error(outcome.message);
  return JSON.stringify(outcome.file);
}

const planOf = (text: string, isUS?: unknown) =>
  JSON.parse((screenJson as (...a: unknown[]) => string)(text, NOW, 'phone', '{}', isUS)).plan;
const shownCards = (sections: UsPlanSection[]) => sections.flatMap((s) => s.cards.flatMap((c) => c.suggestions));

describe('screenJson usProducts (US-61)', () => {
  it('gives a US adult the blocks in Supplements card order, with the ios UTM tag and one ownership line', () => {
    const plan = planOf(sample, true);
    const supplementIds = plan.sections.find((s: { key: string }) => s.key === 'supplements').cards
      .flatMap((c: { suggestions: { id: string }[] }) => c.suggestions.map((s) => s.id));
    const blocked = shownCards(plan.usProducts).filter((s) => s.usProduct);
    const ids = blocked.map((s) => s.id);
    expect(ids).toEqual(supplementIds.filter((id: string) => id !== 'supplement-omega3'));
    expect(ids).toContain('supplement-sleep');
    for (const { usProduct } of blocked) {
      expect(usProduct!.url).toMatch(/^https:\/\/microvitamin\.com\/products\/(microvitamin-plus|sleep)\?utm_source=health-tool&utm_medium=ios$/);
    }
    expect(plan.usProducts.map((s: UsPlanSection) => s.ownershipLine ?? null).filter(Boolean)).toEqual([US_OWNERSHIP_LINE]);
  });

  it('carries each variant card\'s US text and references, and the sections keep the base text', () => {
    const plan = planOf(sample, true);
    const base = shownCards(plan.usProducts).find((s) => s.id === 'supplement-micronutrient-base')!;
    expect(base.description).toBe(US_SUPPLEMENT_DESCRIPTIONS['supplement-micronutrient-base']);
    expect(base.references).toEqual(US_SUPPLEMENT_REFERENCES['supplement-micronutrient-base']);
    const collagen = shownCards(plan.usProducts).find((s) => s.id === 'supplement-collagen')!;
    expect(collagen.description).toBe(shownCards(plan.sections).find((s) => s.id === 'supplement-collagen')!.description);
    // AC3: the plan's own sections never carry a product or a US variant.
    expect(JSON.stringify(plan.sections)).not.toMatch(/MicroVitamin|microvitamin\.com|usProduct|ownershipLine/);
    expect(JSON.stringify(plan.sections)).not.toContain(US_SUPPLEMENT_DESCRIPTIONS['supplement-creatine'] + '"');
    expect(plan.sections).toEqual(planOf(sample, false).sections);
  });

  // Placement is us-products.ts's alone: the engine ships exactly what it returns.
  it('ships usProductSections\' own answer, ready to draw', () => {
    const plan = planOf(sample, true);
    const computed = computePlan(readRecord(sample, NOW, 'phone'), new Date(NOW));
    expect(plan.usProducts).toEqual(JSON.parse(JSON.stringify(usProductSections(planSections(computed.results.suggestions), computed.results, true, 'ios'))));
  });

  it('gives no overlay outside the US, or for anything but a true isUS (an older app sends none)', () => {
    for (const isUS of [false, undefined, 'true', 1, 'USA']) {
      expect(planOf(sample, isUS).usProducts, String(isUS)).toBeUndefined();
    }
  });

  // D14: the old app (builds 3 and 4, bridge 2d46) calls with four arguments; the new engine
  // then answers as it did before US-61, with no block and no line.
  it('gives an old app that sends four arguments no overlay', () => {
    const plan = JSON.parse(screenJson(sample, NOW, 'phone', '{}')).plan;
    expect(plan.usProducts).toBeUndefined();
    expect(plan.sections).toEqual(planOf(sample, true).sections);
  });

  it('gives a known minor and an unknown age no overlay, even in the US (medicinesShown)', () => {
    expect(planOf(record({ birthYear: 2012, birthMonth: 1 }), true).usProducts).toBeUndefined();
    expect(planOf(record({}), true).usProducts).toBeUndefined();
    expect(shownCards(planOf(record({ birthYear: 1970, birthMonth: 1 }), true).usProducts).some((s) => s.usProduct)).toBe(true);
  });
});
