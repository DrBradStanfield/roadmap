import { describe, it, expect } from 'vitest';
import { LAB_CATALOG } from '@roadmap/health-core';
import { labUnitRefusalLine, labValueLabel, measurementRefusalLine } from './lab-value-labels';

// US-21 AC11 / AC7: a catalogued test printed with no unit is refused, and the
// line says so plainly instead of "unit not recognised ()" (adversary R3).
describe('labUnitRefusalLine: no unit printed', () => {
  it('names the missing unit and the unit the test takes', () => {
    expect(labUnitRefusalLine('ferritin', '')).toBe('Ferritin: no unit was printed, so it was not saved. This test takes µg/L.');
    expect(labUnitRefusalLine('ferritin', '  ')).toBe('Ferritin: no unit was printed, so it was not saved. This test takes µg/L.');
  });

  it('keeps the unrecognised-unit line for a unit that was printed', () => {
    expect(labUnitRefusalLine('ferritin', 'mg/dL')).toMatch(/^Ferritin: unit not recognised \(mg\/dL\)\. It was not saved\. This test takes µg\/L\./);
  });
});

// A test is named by its catalogue label, the rule the review and the matrix
// already used (US-21 AC18); only a name off the catalogue is title-cased.
describe('labValueLabel', () => {
  it('names a catalogued test by its catalogue label, from its key or an alias', () => {
    expect(labValueLabel('sodium')).toBe('Sodium');
    expect(labValueLabel('ft4')).toBe('Free T4');
    expect(labValueLabel('free_t4')).toBe('Free T4');
    expect(labValueLabel('hs_crp')).toBe('CRP');
    expect(labValueLabel('igf1')).toBe('IGF-1');
    expect(labValueLabel('dhea_s')).toBe('DHEA-S');
    expect(labValueLabel('vitamin_d')).toBe('Vitamin D (25-OH)');
  });

  it('gives every catalogue key its catalogue label', () => {
    for (const entry of LAB_CATALOG) expect(labValueLabel(entry.key), entry.key).toBe(entry.label);
  });

  it('title-cases a snake_case name off the catalogue', () => {
    expect(labValueLabel('ana_titre')).toBe('Ana Titre');
    expect(labValueLabel('plateletcrit')).toBe('Plateletcrit');
    expect(labValueLabel('mean_platelet_component_x')).toBe('Mean Platelet Component X');
  });

  it('names the test in a refused-unit line by its catalogue label', () => {
    expect(labUnitRefusalLine('vitamin_d', 'mg/dL')).toMatch(/^Vitamin D \(25-OH\): unit not recognised/);
  });
});

// US-12 AC6 / US-35 AC17: a refused blood test value is named by its test,
// with a reason the person can act on, and never the number. Out of range, it
// names the end of the range it missed, in the units the person reads (Brad,
// 2026-10-20: "explain what's out of range, otherwise it will confuse users").
describe('measurementRefusalLine', () => {
  it('words each refusal reason on its own', () => {
    expect(measurementRefusalLine({ index: 0, metricType: 'ldl', reason: 'out-of-range', message: 'synthetic', bound: 'above' }, 'si'))
      .toBe('LDL Cholesterol not saved: above 12.9 mmol/L, the highest value this tool accepts. Check the report, then enter it again.');
    expect(measurementRefusalLine({ index: 0, metricType: 'ldl', reason: 'invalid-value', message: 'synthetic' }, 'si'))
      .toBe('LDL Cholesterol: the value was not a number the record can store, so it was not saved.');
    expect(measurementRefusalLine({ index: 0, metricType: 'toString', reason: 'unknown-metric', message: 'synthetic' }, 'si'))
      .toBe('toString: not a test the record knows, so it was not saved.');
  });

  it('names the PSA ceiling of 10,000 ng/mL', () => {
    expect(measurementRefusalLine({ index: 0, metricType: 'psa', reason: 'out-of-range', message: 'synthetic', bound: 'above' }, 'si'))
      .toBe('PSA not saved: above 10,000 ng/mL, the highest value this tool accepts. Check the report, then enter it again.');
  });

  it('names the floor for a value below the range, in US units when the person reads them', () => {
    expect(measurementRefusalLine({ index: 0, metricType: 'hba1c', reason: 'out-of-range', message: 'synthetic', bound: 'below' }, 'si'))
      .toBe('HbA1c not saved: below 9 mmol/mol, the lowest value this tool accepts. Check the report, then enter it again.');
    expect(measurementRefusalLine({ index: 0, metricType: 'ldl', reason: 'out-of-range', message: 'synthetic', bound: 'above' }, 'conventional'))
      .toBe('LDL Cholesterol not saved: above 500 mg/dL, the highest value this tool accepts. Check the report, then enter it again.');
  });
});
