// Pins for calculations.ts behaviour that no other test checks. A mutation
// run (mewt, then re-checked by hand on main) showed these lines could change
// with every existing test still passing. Current behaviour only.
import { describe, it, expect } from 'vitest';
import { calculateEGFR, isKnownMinor } from './calculations';
import { CREATININE_FACTOR, UNIT_DEFS } from './units';

// isKnownMinor(): `year - birthYear` on both paths. Subtraction and `%` agree
// for every past birth year; they differ only for a birth year ahead of the
// UTC-12 year, which is a newborn somewhere east on 1 January.
describe('isKnownMinor: a birth year ahead of the UTC-12 year is still a minor', () => {
  // 06:00 UTC on 1 Jan 2027 is still 31 Dec 2026 at UTC-12; a 2027 birth
  // year (valid locally that morning) is a newborn, so a known minor.
  const now = new Date('2027-01-01T06:00:00Z');
  it('without a birth month', () => {
    expect(isKnownMinor(2027, undefined, now)).toBe(true);
  });
  it('with a birth month', () => {
    expect(isKnownMinor(2027, 1, now)).toBe(true);
  });
});

// calculateEGFR() converts µmol/L to mg/dL with the same factor the unit
// layer uses (US-64, lead A2-4). It once carried its own 88.4; if that copy
// comes back and the two drift, a creatinine of exactly kappa mg/dL entered
// through UNIT_DEFS no longer lands on the CKD-EPI kink, and this fails.
describe('calculateEGFR: one creatinine factor, shared with UNIT_DEFS', () => {
  it('the exported factor is the one UNIT_DEFS converts with', () => {
    expect(UNIT_DEFS.creatinine.toCanonical.conventional(1)).toBe(CREATININE_FACTOR);
  });
  it.each([['male', 0.9], ['female', 0.7]] as const)('%s: kappa mg/dL through UNIT_DEFS gives the kink value', (sex, kappa) => {
    const umol = UNIT_DEFS.creatinine.toCanonical.conventional(kappa);
    const sexTerm = sex === 'female' ? 1.012 : 1;
    expect(calculateEGFR(umol, 50, sex)).toBeCloseTo(142 * Math.pow(0.9938, 50) * sexTerm, 9);
  });
});
