// US-61 AC4, AC5, AC7, AC8 on the iPhone: screenJson carries health-core's own US overlay
// (us-products.ts) beside the plan, for a known adult on a US App Store storefront only.
// The sections stay the web's planSections, product-free; Swift places the blocks.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { US_SUPPLEMENT_DESCRIPTIONS } from '../../packages/health-core/src/suggestions';
import { US_SUPPLEMENT_REFERENCES } from '../../packages/health-core/src/evidence';
import { US_OWNERSHIP_LINE } from '../../packages/health-core/src/us-products';
import type { RoadmapFile } from '../../packages/health-core/src/roadmap-file';
import { applyEdit, newRecord } from './my-data';
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

describe('screenJson usProducts (US-61)', () => {
  it('gives a US adult the blocks in Supplements card order, with the ios UTM tag and one ownership line', () => {
    const plan = planOf(sample, true);
    const supplementIds = plan.sections.find((s: { key: string }) => s.key === 'supplements').cards
      .flatMap((c: { suggestions: { id: string }[] }) => c.suggestions.map((s) => s.id));
    const ids = plan.usProducts.blocks.map((b: { suggestionId: string }) => b.suggestionId);
    expect(ids).toEqual(supplementIds.filter((id: string) => id !== 'supplement-omega3'));
    expect(ids).toContain('supplement-sleep');
    for (const block of plan.usProducts.blocks) {
      expect(block.url).toMatch(/^https:\/\/microvitamin\.com\/products\/(microvitamin-plus|sleep)\?utm_source=health-tool&utm_medium=ios$/);
    }
    expect(plan.usProducts.ownershipLine).toBe(US_OWNERSHIP_LINE);
  });

  it('carries each variant card\'s US text and references, and the sections keep the base text', () => {
    const plan = planOf(sample, true);
    const base = plan.usProducts.blocks.find((b: { suggestionId: string }) => b.suggestionId === 'supplement-micronutrient-base');
    expect(base.description).toBe(US_SUPPLEMENT_DESCRIPTIONS['supplement-micronutrient-base-us']);
    expect(base.references).toEqual(US_SUPPLEMENT_REFERENCES['supplement-micronutrient-base-us']);
    const collagen = plan.usProducts.blocks.find((b: { suggestionId: string }) => b.suggestionId === 'supplement-collagen');
    expect(collagen.description).toBeUndefined();
    // AC3: the plan's own sections never carry a product or a -us variant.
    expect(JSON.stringify(plan.sections)).not.toMatch(/MicroVitamin|microvitamin\.com|-us"/);
    expect(plan.sections).toEqual(planOf(sample, false).sections);
  });

  it('gives no block and no line outside the US, or for anything but a true isUS (an older app sends none)', () => {
    for (const isUS of [false, undefined, 'true', 1, 'USA']) {
      expect(planOf(sample, isUS).usProducts, String(isUS)).toEqual({ blocks: [], ownershipLine: null });
    }
  });

  it('gives a known minor and an unknown age no block, even in the US (medicinesShown)', () => {
    expect(planOf(record({ birthYear: 2012, birthMonth: 1 }), true).usProducts).toEqual({ blocks: [], ownershipLine: null });
    expect(planOf(record({}), true).usProducts).toEqual({ blocks: [], ownershipLine: null });
    expect(planOf(record({ birthYear: 1970, birthMonth: 1 }), true).usProducts.blocks.length).toBeGreaterThan(0);
  });
});
