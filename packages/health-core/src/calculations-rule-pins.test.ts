// Pins for calculations.ts behaviour that no other test checks. A mutation
// run (mewt, then re-checked by hand on main) showed these lines could change
// with every existing test still passing. Current behaviour only.
import { describe, it, expect } from 'vitest';
import { isKnownMinor } from './calculations';

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
