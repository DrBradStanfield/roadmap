// US-05 AC2: which unit Lp(a)'s field opens in.
import { describe, it, expect } from 'vitest';
import { effectiveLpaUnit } from './lpa-unit';

describe('US-05 AC2 — the unit Lp(a)’s field opens in', () => {
  it('with nothing chosen: mg/dL in US units, nmol/L in any other', () => {
    expect(effectiveLpaUnit(undefined, undefined, 'conventional')).toBe('mg/dL');
    expect(effectiveLpaUnit(undefined, undefined, 'si')).toBe('nmol/L');
  });

  it('the unit chosen in the record wins over the default and the old toggle', () => {
    expect(effectiveLpaUnit('mg/L', undefined, 'conventional')).toBe('mg/L');
    expect(effectiveLpaUnit('nmol/L', 'conventional', 'si')).toBe('nmol/L');
  });

  it('legacy: the old build’s toggle set to conventional was its mg/L; set to SI, nmol/L', () => {
    expect(effectiveLpaUnit(undefined, 'conventional', 'si')).toBe('mg/L');
    expect(effectiveLpaUnit(undefined, 'si', 'conventional')).toBe('nmol/L');
  });

  it('a value the record cannot mean (a hand edit) reads as nothing chosen', () => {
    expect(effectiveLpaUnit('mmol/L', undefined, 'conventional')).toBe('mg/dL');
    expect(effectiveLpaUnit(42, 'banana', 'si')).toBe('nmol/L');
  });
});
