// US-25 AC2, AC22: one door answers both My data and the Plan tab (screenJson), from
// one read of the record and one computePlan, so the two always show the same record.
// A plan that cannot be made never blanks My data.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as planModule from '../../packages/health-core/src/plan';
import { planSections } from '../../packages/health-core/src/plan-sections';
import { statTiles } from '../../packages/health-core/src/stat-tiles';
import { myData, newRecord, readRecord } from './my-data';
import { screenJson } from './entry';

vi.mock('../../packages/health-core/src/plan', async (original) => {
  const real = await original<typeof planModule>();
  return { ...real, computePlan: vi.fn(real.computePlan) };
});
const computePlan = vi.mocked(planModule.computePlan);

const NOW = '2026-10-21T08:00:00.000Z';
const sample = readFileSync(join(__dirname, '../../docs/examples/health-roadmap.sample.json'), 'utf8');
const UNITS = '{"hba1c":"conventional","ldl":"conventional"}';

afterEach(() => computePlan.mockClear());

describe('screenJson (US-25 AC2, AC22)', () => {
  it('is My data and the plan view, as the separate doors gave them', () => {
    const file = readRecord(sample, NOW, 'phone');
    const choices = { hba1c: 'conventional', ldl: 'conventional' } as const;
    const plan = planModule.computePlan(file, new Date(NOW), choices);
    const tiles = statTiles(plan.results, { unitSystem: plan.unitSystem, unitOverrides: choices, sex: plan.inputs.sex });
    expect(JSON.parse(screenJson(sample, NOW, 'phone', UNITS))).toEqual({
      myData: JSON.parse(JSON.stringify(myData(file, NOW, choices))),
      plan: { sections: JSON.parse(JSON.stringify(planSections(plan.results.suggestions))), tiles: JSON.parse(JSON.stringify(tiles)), usProducts: { blocks: [], ownershipLine: null }, ms: expect.any(Number) },
    });
  });

  it('times the plan alone: computePlan through the tiles and the layout, not My data (D2\'s plan budget)', () => {
    let clock = 1000;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const real = computePlan.getMockImplementation()!;
    computePlan.mockImplementationOnce((...args) => { clock += 7; return real(...args); });
    try {
      expect(JSON.parse(screenJson(sample, NOW, 'phone', UNITS)).plan.ms).toBe(7);
    } finally {
      now.mockRestore();
    }
  });

  it('plans the record once per call', () => {
    screenJson(sample, NOW, 'phone', UNITS);
    expect(computePlan).toHaveBeenCalledTimes(1);
  });

  it('answers a record with no height with My data and health-core\'s PlanError', () => {
    const empty = JSON.stringify(newRecord(NOW, 'phone', 'en-NZ', 'Pacific/Auckland'));
    const screen = JSON.parse(screenJson(empty, NOW, 'phone', '{}'));
    expect(screen.myData.vitals.length).toBeGreaterThan(0);
    expect(screen.plan.planError).toBe(true);
    expect(screen.plan.error).toMatch(/^PlanError: /);
    expect(screen.plan.sections).toBeUndefined();
    expect(computePlan).toHaveBeenCalledTimes(1);
  });

  // US-07 AC8: no sex is no longer a PlanError; the plan comes without the parts that need it.
  it('plans a record with a height and no sex, without the ideal body weight and protein tiles', () => {
    const record = newRecord(NOW, 'phone', 'en-NZ', 'Pacific/Auckland');
    record.profile.heightCm = 170;
    const screen = JSON.parse(screenJson(JSON.stringify(record), NOW, 'phone', '{}'));
    expect(screen.plan.planError).toBeUndefined();
    expect(screen.plan.sections.length).toBeGreaterThan(0);
    const keys = screen.plan.tiles.map((t: { key: string }) => t.key);
    expect(keys).not.toContain('ibw');
    expect(keys).not.toContain('protein');
  });

  it('keeps My data when the plan throws anything else, and says it was not a PlanError', () => {
    computePlan.mockImplementationOnce(() => { throw new Error('broken on purpose'); });
    const screen = JSON.parse(screenJson(sample, NOW, 'phone', '{}'));
    expect(screen.myData.vitals.length).toBeGreaterThan(0);
    expect(screen.plan).toEqual({ error: 'Error: broken on purpose', planError: false });
  });
});
