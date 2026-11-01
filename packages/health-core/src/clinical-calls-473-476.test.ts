// US-07 AC9: Brad's calls on Austin Bell's issues 473-476 (2026-11-02).
import { describe, expect, it } from 'vitest';
import { generateSuggestions } from './suggestions';
import { STAT_CARD_EVIDENCE, getIbwEvidence } from './evidence';
import { getBMICategory } from './calculations';
import { statTiles } from './stat-tiles';
import { labSlotKey, labTestLabel, canonicalLabRow, resolveLabCatalogEntry } from './lab-catalog';
import { unifiedSystemPrompt } from './lab-extraction';
import { toCanonicalValue } from './units';
import type { HealthInputs, HealthResults } from './types';

describe('US-07 AC9: SGLT2 inhibitor card (issue 473)', () => {
  // Austin's case: no diabetes, no heart failure, on tirzepatide at its highest dose.
  const inputs: HealthInputs = { heightCm: 178, sex: 'male', hba1c: 36, triglycerides: toCanonicalValue('triglycerides', 177, 'conventional') };
  const results: HealthResults = { heightCm: 178, idealBodyWeight: 76, proteinTarget: 91, age: 50, bmi: 27, bmiCategory: getBMICategory(27), suggestions: [] };
  const card = generateSuggestions(inputs, results, 'si', { glp1: { drug: 'tirzepatide', dose: 15 } })
    .find((s) => s.id === 'weight-med-sglt2i');

  it('says the protection is proven in some populations', () => {
    expect(card?.reason).toContain('they provide proven cardiovascular and kidney protection in some populations, making them a valuable addition for metabolic health.');
  });

  it('cites the outcome trials and meta-analyses behind it', () => {
    expect(card?.references?.map((r) => r.url)).toEqual([
      'https://doi.org/10.1056/NEJMoa1504720',
      'https://doi.org/10.1056/NEJMoa1911303',
      'https://doi.org/10.1056/NEJMoa2024816',
      'https://doi.org/10.1016/S0140-6736(22)01429-5',
      'https://doi.org/10.1001/jama.2025.20834',
    ]);
  });
});

describe('US-07 AC9: eGFR labels (issue 474)', () => {
  const tile = (eGFR: number) => statTiles({ heightCm: 175, eGFR, suggestions: [] } as HealthResults, { unitSystem: 'si', sex: 'male' })
    .find((t) => t.key === 'egfr');

  it.each([
    [70, 'Normal', 'normal'], [69, 'Low Normal', 'info'], [60, 'Low Normal', 'info'],
    [59, 'Mildly to Moderately Decreased', 'attention'], [45, 'Mildly to Moderately Decreased', 'attention'],
    [44, 'Moderately to Severely Decreased', 'attention'], [30, 'Moderately to Severely Decreased', 'attention'],
    [29, 'Severely Decreased', 'urgent'], [14, 'Kidney Failure', 'urgent'],
  ] as const)('eGFR %i reads "%s" on the tile, in its colour', (egfr, label, tone) => {
    expect(tile(egfr)?.status).toEqual({ label, tone });
  });

  it("the card names KDIGO's categories, says the top two bands are the tool's own, and cites KDIGO", () => {
    const { reason, references } = STAT_CARD_EVIDENCE['egfr'];
    expect(reason).toContain('45-59 Mildly to Moderately Decreased (KDIGO G3a), 30-44 Moderately to Severely Decreased (G3b)');
    expect(reason).toContain("The two bands from 60 up are this tool's own: KDIGO 2024 calls 60-89 mildly decreased (G2).");
    expect(reason).not.toMatch(/Stage 3a|Stage 3b/);
    expect(references.map((r) => r.url)).toContain('https://doi.org/10.1016/j.kint.2023.10.018');
  });
});

describe('US-07 AC9: ideal body weight card (issue 475)', () => {
  it.each(['male', 'female'] as const)('for %s ends with Austin\'s sentence', (sex) => {
    expect(getIbwEvidence(sex).reason.endsWith('Unlike older formulas such as Devine (1974), which over- or underestimate at the short and tall ends, the Peterson formula follows BMI at every height. The app sets a different target BMI for men and women.')).toBe(true);
  });
});

describe('US-07 AC9: cortisol by timing (issue 476)', () => {
  it.each([
    ['Cortisol', 'cortisol_am', 'Cortisol (morning)'],
    ['Cortisol, AM', 'cortisol_am', 'Cortisol (morning)'],
    ['Morning Cortisol', 'cortisol_am', 'Cortisol (morning)'],
    ['Cortisol, Random', 'cortisol_random', 'Cortisol (random)'],
    ['Random cortisol', 'cortisol_random', 'Cortisol (random)'],
    ['Cortisol PM', 'cortisol_pm', 'Cortisol (PM)'],
    ['Evening cortisol', 'cortisol_pm', 'Cortisol (PM)'],
    ['Midnight Cortisol', 'cortisol_pm', 'Cortisol (PM)'],
  ])('"%s" is filed under %s, read as "%s"', (printed, slot, label) => {
    expect(labSlotKey(printed)).toBe(slot);
    expect(labTestLabel(printed)).toBe(label);
  });

  it.each(['Salivary cortisol', 'Late-night salivary cortisol', 'Urine free cortisol', 'Cortisol, urine'])('"%s" stays under its printed name', (printed) => {
    expect(resolveLabCatalogEntry(printed)).toBeUndefined();
  });

  it.each(['Cortisol, Random', 'Cortisol PM'])('%s in µg/dL is stored in nmol/L at 27.59', (printed) => {
    const entry = resolveLabCatalogEntry(printed)!;
    expect(canonicalLabRow(entry, { value: 10, unit: 'µg/dL', referenceLow: 2, referenceHigh: 14 })?.stored)
      .toMatchObject({ value: 275.9, unit: 'nmol/L' });
  });

  it('the upload prompt does not offer the new names yet', () => {
    const prompt = unifiedSystemPrompt('full');
    expect(prompt).toContain('cortisol_am');
    expect(prompt).not.toMatch(/cortisol_random|cortisol_pm/);
  });
});
