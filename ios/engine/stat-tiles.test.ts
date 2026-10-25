// US-25 AC22: the plan's summary tiles are the web's Quick Stats (ResultsPanel.tsx),
// worked out by health-core in the engine, never in Swift.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { planJson, screenJson, sectionsJson } from './entry';
import { STAT_TILE_ABOUT, STAT_TILE_ABOUT_MINOR_BMI, statTiles as tilesFor, type StatTile } from '../../packages/health-core/src/stat-tiles';
import type { Plan } from '../../packages/health-core/src/plan';
import { STAT_CARD_EVIDENCE, getIbwEvidence } from '../../packages/health-core/src/evidence';

const NOW = '2026-10-21T08:00:00.000Z';
const sample = JSON.parse(readFileSync(join(__dirname, '../../docs/examples/health-roadmap.sample.json'), 'utf8'));

function recordOf(edit: (record: typeof sample) => void = () => {}): string {
  const record = JSON.parse(JSON.stringify(sample));
  edit(record);
  return JSON.stringify(record);
}

function add(record: typeof sample, metricType: string, value: number) {
  record.measurements.push({
    id: `test-${metricType}`, metricType, value, recordedAt: '2026-05-12', createdAt: '2026-05-12T08:00:00Z',
    source: 'manual', status: 'active', correctsId: null, externalId: null,
  });
}

const byKey = (tiles: StatTile[]) => Object.fromEntries(tiles.map((t) => [t.key, t]));
/** The tiles as the app reads them: the plan half of the engine's screen door. */
const statTiles = (record: string, unitsJson = '{}'): StatTile[] => JSON.parse(screenJson(record, NOW, 'phone', unitsJson)).plan.tiles;

describe('statTiles (US-25 AC22)', () => {
  it('gives the sample the web\'s tiles, in its order, with its words', () => {
    const tiles = statTiles(recordOf());
    expect(tiles.map((t) => t.key)).toEqual(['bmi', 'ibw', 'protein', 'ldl', 'hba1c']);
    const t = byKey(tiles);
    // BMI 25-29.9 with no waist: no label, the plan asks for the waist instead.
    expect(t.bmi).toMatchObject({ label: 'BMI', value: '25.2', unit: '' });
    expect(t.bmi.status).toBeUndefined();
    expect(t.ibw).toMatchObject({ label: 'Ideal Body Weight', value: '60.0', unit: 'kg', status: { label: 'for 165 cm height', tone: 'normal' } });
    expect(t.ibw.evidence).toEqual(getIbwEvidence('female'));
    expect(t.protein).toMatchObject({ label: 'Protein Target', value: '72', unit: 'g/day', status: { label: '1.2g per kg IBW', tone: 'normal' } });
    expect(t.ldl).toMatchObject({ label: 'LDL Cholesterol', value: '3.6', unit: 'mmol/L', status: { label: 'Borderline', tone: 'info' } });
    expect(t.ldl.evidence).toEqual(STAT_CARD_EVIDENCE['ldl']);
    expect(t.hba1c).toMatchObject({ label: 'HbA1c', value: '38', unit: 'mmol/mol', status: { label: 'Normal', tone: 'normal' } });
  });

  it('puts waist-to-height first, and with it BMI gets its label', () => {
    const t = byKey(statTiles(recordOf((r) => add(r, 'waist', 90))));
    expect(Object.keys(t)[0]).toBe('whtr');
    expect(t.whtr).toMatchObject({ label: 'Waist-to-Height', status: { label: 'Elevated', tone: 'attention' } });
    expect(t.whtr.evidence).toEqual(STAT_CARD_EVIDENCE['whtr']);
    expect(t.bmi.status).toBeDefined();
  });

  it('shows eGFR from creatinine, the non-HDL tile from total cholesterol, and Lp(a)', () => {
    const t = byKey(statTiles(recordOf((r) => { add(r, 'creatinine', 70); add(r, 'total_cholesterol', 6); add(r, 'lpa', 130); })));
    expect(t.egfr).toMatchObject({ label: 'eGFR', unit: 'mL/min', status: { tone: 'normal' } });
    expect(t.nonHdl).toMatchObject({ label: 'Non-HDL Cholesterol', unit: 'mmol/L' });
    expect(t.ldl).toBeUndefined();
    expect(t.lpa).toMatchObject({ label: 'Lp(a)', value: '130', unit: 'nmol/L', status: { label: 'Elevated', tone: 'attention' } });
  });

  it('reads each test in the phone\'s own units (AC17e)', () => {
    const t = byKey(statTiles(recordOf(), JSON.stringify({ hba1c: 'conventional', weight: 'conventional' })));
    expect(t.hba1c).toMatchObject({ value: '5.6', unit: '%' });
    expect(t.ibw.unit).toBe('lbs');
    // Height stays in the record's units, as the web's tile does.
    expect(t.ibw.status?.label).toBe('for 165 cm height');
  });

  it('gives a known minor the values and no adult reading (US-07 AC6)', () => {
    const tiles = statTiles(recordOf((r) => { r.profile.birthYear = 2012; add(r, 'creatinine', 70); }));
    expect(tiles.map((t) => t.key)).toEqual(['bmi', 'ldl', 'hba1c']);
    for (const tile of tiles) {
      expect(tile.status, tile.key).toBeUndefined();
      expect(tile.evidence, tile.key).toBeUndefined();
      // US-57 AC5: a minor's tile still says what it is; BMI says children use growth charts.
      expect(tile.about, tile.key).toBe(tile.key === 'bmi' ? STAT_TILE_ABOUT_MINOR_BMI : STAT_TILE_ABOUT[tile.key]);
    }
  });

  it('serves each tile\'s "what it is" through the screen door (US-57 AC5)', () => {
    for (const tile of statTiles(recordOf())) expect(tile.about, tile.key).toBe(STAT_TILE_ABOUT[tile.key]);
  });

  it('is health-core\'s statTiles for the plan, as JSON', () => {
    const plan = JSON.parse(planJson(recordOf(), NOW, 'phone', '{"hba1c":"conventional"}')) as Plan;
    const direct = tilesFor(plan.results, { unitSystem: plan.unitSystem, unitOverrides: { hba1c: 'conventional' }, sex: plan.inputs.sex });
    expect(statTiles(recordOf(), '{"hba1c":"conventional"}')).toEqual(JSON.parse(JSON.stringify(direct)));
  });

  it('screenJson\'s plan is the separate plan, sections and tiles it replaced, from one computePlan', () => {
    for (const units of ['{}', '{"hba1c":"conventional","ldl":"conventional","weight":"conventional"}']) {
      const record = recordOf((r) => { add(r, 'waist', 90); add(r, 'creatinine', 70); });
      const plan = planJson(record, NOW, 'phone', units);
      const parsed = JSON.parse(plan) as Plan;
      const tiles = tilesFor(parsed.results, { unitSystem: parsed.unitSystem, unitOverrides: JSON.parse(units), sex: parsed.inputs.sex });
      expect(JSON.parse(screenJson(record, NOW, 'phone', units)).plan).toEqual({
        sections: JSON.parse(sectionsJson(plan)),
        tiles: JSON.parse(JSON.stringify(tiles)),
        ms: expect.any(Number),
      });
    }
  });
});
