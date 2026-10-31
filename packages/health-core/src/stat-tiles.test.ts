// US-25 AC22: the plan's summary tiles, one source for the web's Quick Stats and the phone's tiles.
import { describe, expect, it } from 'vitest';
import { STAT_TILE_ABOUT, STAT_TILE_ABOUT_MINOR_BMI, statTiles, statTileText, type StatTile, type StatTileKey, type StatTileOptions } from './stat-tiles';
import { calculateHealthResults } from './calculations';
import { STAT_CARD_EVIDENCE, getBmiEvidence, getIbwEvidence, getProteinEvidence } from './evidence';
import type { HealthResults } from './types';

const SI: StatTileOptions = { unitSystem: 'si', sex: 'male' };

function results(extra: Partial<HealthResults> = {}): HealthResults {
  return { heightCm: 175, idealBodyWeight: 70.5, proteinTarget: 85, suggestions: [], ...extra };
}

const byKey = (tiles: StatTile[]) => Object.fromEntries(tiles.map((t) => [t.key, t]));
const tile = (r: Partial<HealthResults>, key: string, opts: StatTileOptions = SI) => byKey(statTiles(results(r), opts))[key];

describe('statTiles order and selection', () => {
  it('lists every tile in the web order', () => {
    const r = calculateHealthResults({
      heightCm: 175, weightKg: 80, waistCm: 90, sex: 'male', ldlC: 3, apoB: 0.8, creatinine: 80, lpa: 60, hba1c: 36, birthYear: 1980,
    });
    expect(statTiles(r, SI).map((t) => t.key)).toEqual(['whtr', 'bmi', 'ibw', 'protein', 'apoB', 'egfr', 'lpa', 'hba1c']);
  });

  it('shows only IBW and protein with height and sex alone', () => {
    expect(statTiles(results(), SI).map((t) => t.key)).toEqual(['ibw', 'protein']);
  });
});

describe('BMI tile', () => {
  it.each([
    ['Underweight', 0.4, { label: 'Underweight', tone: 'attention' }],
    ['Normal', 0.45, { label: 'Normal', tone: 'normal' }],
    ['Overweight', 0.55, { label: 'Overweight', tone: 'info' }],
    ['Obese (Class I)', 0.6, { label: 'Obese', tone: 'attention' }],
    ['Obese (Class III)', undefined, { label: 'Obese', tone: 'attention' }],
  ])('%s with WHtR %s', (bmiCategory, waistToHeightRatio, status) => {
    expect(tile({ bmi: 27, bmiCategory, waistToHeightRatio }, 'bmi').status).toEqual(status);
  });

  it('has no status for BMI 25-29.9 without a waist, but keeps its evidence', () => {
    const t = tile({ bmi: 27, bmiCategory: 'Overweight' }, 'bmi');
    expect(t).toMatchObject({ label: 'BMI', value: '27', unit: '' });
    expect(t.status).toBeUndefined();
    expect(t.evidence).toEqual(getBmiEvidence(27, 'male', undefined));
  });

  it('has no evidence without a sex', () => {
    expect(tile({ bmi: 22, bmiCategory: 'Normal' }, 'bmi', { unitSystem: 'si' }).evidence).toBeUndefined();
  });
});

describe('waist-to-height tile', () => {
  it.each([[0.49, 'Healthy', 'normal'], [0.5, 'Elevated', 'attention'], [0.62, 'Elevated', 'attention']])('%s is %s', (ratio, label, tone) => {
    const t = tile({ waistToHeightRatio: ratio }, 'whtr');
    expect(t).toMatchObject({ label: 'Waist-to-Height', value: String(ratio), unit: '', status: { label, tone } });
    expect(t.evidence).toEqual(STAT_CARD_EVIDENCE['whtr']);
  });
});

describe('IBW and protein tiles', () => {
  it('reads IBW in the weight unit and height in the plan units', () => {
    expect(tile({}, 'ibw')).toMatchObject({ label: 'Ideal Body Weight', value: '70.5', unit: 'kg', status: { label: 'for 175 cm height' } });
    expect(tile({}, 'ibw')?.status?.tone).toBeUndefined(); // neutral gray (Brad 2026-10-31)
    expect(tile({}, 'ibw').evidence).toEqual(getIbwEvidence('male'));
    const us = tile({}, 'ibw', { unitSystem: 'conventional', sex: 'male' });
    expect(us.unit).toBe('lbs');
    expect(us.status?.label).toMatch(/^for 5'/);
    // A per-test weight unit leaves the height in the plan's units.
    const mixed = tile({}, 'ibw', { unitSystem: 'si', unitOverrides: { weight: 'conventional' }, sex: 'male' });
    expect(mixed.unit).toBe('lbs');
    expect(mixed.status?.label).toBe('for 175 cm height');
  });

  it('lowers the protein rate below eGFR 45', () => {
    expect(tile({}, 'protein')).toMatchObject({ label: 'Protein Target', value: '85', unit: 'g/day', status: { label: '1.2g per kg IBW' } });
    expect(tile({}, 'protein')?.status?.tone).toBeUndefined();
    expect(tile({}, 'protein').evidence).toEqual(getProteinEvidence(70.5, 1.2, undefined));
    expect(tile({ eGFR: 40 }, 'protein').status?.label).toBe('1.0g per kg IBW');
  });
});

describe('lipid tile', () => {
  it('picks ApoB, then non-HDL, then LDL', () => {
    const all = { apoB: 0.8, nonHdlCholesterol: 4, ldlC: 3 };
    expect(byKey(statTiles(results(all), SI)).apoB).toMatchObject({ label: 'ApoB', unit: 'g/L', status: { label: 'High', tone: 'attention' } });
    const noApoB = byKey(statTiles(results({ nonHdlCholesterol: 4, ldlC: 3 }), SI));
    expect(noApoB.nonHdl).toMatchObject({ label: 'Non-HDL Cholesterol', unit: 'mmol/L' });
    expect(noApoB.nonHdl.evidence).toEqual(STAT_CARD_EVIDENCE['non-hdl']);
    expect(noApoB.ldl).toBeUndefined();
    const ldl = tile({ ldlC: 3.6 }, 'ldl');
    expect(ldl).toMatchObject({ label: 'LDL Cholesterol', value: '3.6', unit: 'mmol/L', status: { label: 'Borderline', tone: 'info' } });
    expect(ldl.evidence).toEqual(STAT_CARD_EVIDENCE['ldl']);
  });

  it('reads in US units', () => {
    expect(tile({ ldlC: 3.6 }, 'ldl', { unitSystem: 'conventional', sex: 'male' })).toMatchObject({ value: '139', unit: 'mg/dL' });
    expect(tile({ ldlC: 3.6 }, 'ldl', { unitSystem: 'si', unitOverrides: { ldl: 'conventional' } }).unit).toBe('mg/dL');
  });
});

describe('eGFR, Lp(a) and HbA1c tiles', () => {
  it.each([
    [75, 'Normal', 'normal'], [65, 'Low Normal', 'info'], [50, 'Mildly Decreased', 'attention'],
    [35, 'Moderately Decreased', 'attention'], [20, 'Severely Decreased', 'urgent'], [10, 'Kidney Failure', 'urgent'],
  ])('eGFR %s is %s', (eGFR, label, tone) => {
    expect(tile({ eGFR }, 'egfr')).toMatchObject({ label: 'eGFR', value: String(eGFR), unit: 'mL/min', status: { label, tone } });
  });

  it.each([[60.4, '60', 'Normal', 'normal'], [100, '100', 'Borderline', 'info'], [130, '130', 'Elevated', 'attention']])('Lp(a) %s', (lpa, value, label, tone) => {
    const t = tile({ lpa }, 'lpa');
    expect(t).toMatchObject({ label: 'Lp(a)', value, unit: 'nmol/L', status: { label, tone } });
    expect(t.evidence).toEqual(STAT_CARD_EVIDENCE['lpa']);
  });

  it.each([[36, 'Normal', 'normal'], [42, 'Prediabetic', 'attention'], [50, 'Diabetic', 'urgent']])('HbA1c %s mmol/mol', (hba1c, label, tone) => {
    expect(tile({ hba1c }, 'hba1c')).toMatchObject({ label: 'HbA1c', value: String(hba1c), unit: 'mmol/mol', status: { label, tone } });
  });

  it('reads HbA1c in %', () => {
    expect(tile({ hba1c: 50 }, 'hba1c', { unitSystem: 'conventional' })).toMatchObject({ value: '6.7', unit: '%' });
  });
});

describe('a known minor (US-07 AC6)', () => {
  it('keeps the values, drops adult readings, IBW, protein and eGFR', () => {
    const tiles = statTiles(results({
      knownMinor: true, bmi: 27, bmiCategory: 'Overweight', waistToHeightRatio: 0.55, ldlC: 4, eGFR: 90, lpa: 200, hba1c: 50,
    }), SI);
    expect(tiles.map((t) => t.key)).toEqual(['whtr', 'bmi', 'ldl', 'lpa', 'hba1c']);
    for (const t of tiles.filter((t) => t.key !== 'whtr')) {
      expect(t.status, t.key).toBeUndefined();
      expect(t.evidence, t.key).toBeUndefined();
    }
    // Waist-to-height keeps its reading, as the web always has.
    expect(tiles[0].status).toEqual({ label: 'Elevated', tone: 'attention' });
  });

  it('keeps each tile\'s "what it is", which grades nothing (US-57 AC5)', () => {
    const tiles = statTiles(results({
      knownMinor: true, bmi: 27, bmiCategory: 'Overweight', waistToHeightRatio: 0.55, ldlC: 4, lpa: 200, hba1c: 50,
    }), SI);
    for (const t of tiles.filter((t) => t.key !== 'bmi')) expect(t.about, t.key).toBe(STAT_TILE_ABOUT[t.key]);
  });

  it('gives a minor\'s BMI tile the growth-chart line, and an adult the waist line (US-07 AC6, Brad 2026-10-25)', () => {
    const minor = byKey(statTiles(results({ knownMinor: true, bmi: 27, bmiCategory: 'Overweight' }), SI));
    expect(minor.bmi.about).toBe('Body mass index: your weight in kilograms divided by your height in metres, squared. For under-18s the plan doesn\'t grade BMI, because children are compared with growth charts instead.');
    expect(minor.bmi.about).toBe(STAT_TILE_ABOUT_MINOR_BMI);
    const adult = byKey(statTiles(results({ bmi: 27, bmiCategory: 'Overweight' }), SI));
    expect(adult.bmi.about).toBe('Body mass index: your weight in kilograms divided by your height in metres, squared. It cannot tell muscle from fat, so your waist measurement can change how the plan reads it.');
  });
});

describe('what each tile is (US-57 AC5, Brad 2026-10-25)', () => {
  const KEYS = ['whtr', 'bmi', 'ibw', 'protein', 'apoB', 'nonHdl', 'ldl', 'egfr', 'lpa', 'hba1c'];

  it('types every tile key, so a tile without a line does not compile', () => {
    const keys: StatTileKey[] = KEYS as StatTileKey[];
    for (const k of keys) expect(STAT_TILE_ABOUT[k], k).toBeTruthy();
  });

  it('has one line for each of the ten tiles, and no other', () => {
    expect(Object.keys(STAT_TILE_ABOUT).sort()).toEqual([...KEYS].sort());
  });

  it('gives every drawn tile its line', () => {
    const r = calculateHealthResults({
      heightCm: 175, weightKg: 80, waistCm: 90, sex: 'male', ldlC: 3, apoB: 0.8, creatinine: 80, lpa: 60, hba1c: 36, birthYear: 1980,
    });
    for (const t of statTiles(r, SI)) expect(t.about, t.key).toBe(STAT_TILE_ABOUT[t.key]);
    const noApoB = byKey(statTiles(results({ nonHdlCholesterol: 4, ldlC: 3 }), SI));
    expect(noApoB.nonHdl.about).toBe(STAT_TILE_ABOUT.nonHdl);
  });

  it('names no threshold, so no line can disagree with a status (or grade a minor)', () => {
    for (const [key, text] of [...Object.entries(STAT_TILE_ABOUT), ['minor bmi', STAT_TILE_ABOUT_MINOR_BMI]]) {
      expect(text, key).not.toMatch(/[<>≥≤]|\b0\.5\b|\d+\s*(mg|mmol|nmol|mL|%)/);
      expect(text, key).not.toContain('—');
    }
  });
});

describe('statTileText', () => {
  it('prints value and unit as the web does', () => {
    const t = byKey(statTiles(results({ bmi: 22, bmiCategory: 'Normal', eGFR: 80 }), SI));
    expect(statTileText(t.bmi)).toBe('22');
    expect(statTileText(t.ibw)).toBe('70.5 kg');
    expect(statTileText(t.protein)).toBe('85g/day');
    expect(statTileText(t.egfr)).toBe('80 mL/min');
  });
});
