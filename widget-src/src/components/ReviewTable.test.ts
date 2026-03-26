import { describe, it, expect } from 'vitest';
import { isScreeningEligible } from './ReviewTable';

// ---------------------------------------------------------------------------
// Bug: MRI scan mentioning prostate triggered screening date update for a
// 34-year-old male. Prostate screening threshold is 45+.
// ---------------------------------------------------------------------------

describe('isScreeningEligible', () => {
  // Age thresholds
  it('rejects prostate screening for male age 34', () => {
    expect(isScreeningEligible('prostate', 34, 'male')).toBe(false);
  });

  it('accepts prostate screening for male age 45', () => {
    expect(isScreeningEligible('prostate', 45, 'male')).toBe(true);
  });

  it('accepts prostate screening for male age 50', () => {
    expect(isScreeningEligible('prostate', 50, 'male')).toBe(true);
  });

  it('rejects colorectal screening for age 30', () => {
    expect(isScreeningEligible('colorectal', 30)).toBe(false);
  });

  it('accepts colorectal screening for age 35', () => {
    expect(isScreeningEligible('colorectal', 35)).toBe(true);
  });

  it('rejects breast screening for age 35', () => {
    expect(isScreeningEligible('breast', 35, 'female')).toBe(false);
  });

  it('accepts breast screening for female age 40', () => {
    expect(isScreeningEligible('breast', 40, 'female')).toBe(true);
  });

  // Sex restrictions
  it('rejects breast screening for male', () => {
    expect(isScreeningEligible('breast', 50, 'male')).toBe(false);
  });

  it('rejects prostate screening for female', () => {
    expect(isScreeningEligible('prostate', 50, 'female')).toBe(false);
  });

  it('rejects cervical screening for male', () => {
    expect(isScreeningEligible('cervical', 30, 'male')).toBe(false);
  });

  it('accepts cervical screening for female age 25', () => {
    expect(isScreeningEligible('cervical', 25, 'female')).toBe(true);
  });

  // Unknown screening type — should allow
  it('allows unknown screening type', () => {
    expect(isScreeningEligible('unknown_type', 20)).toBe(true);
  });

  // Missing age/sex — should allow (defensive)
  it('allows when age is undefined', () => {
    expect(isScreeningEligible('prostate', undefined, 'male')).toBe(true);
  });

  it('allows when sex is undefined', () => {
    expect(isScreeningEligible('breast', 50)).toBe(true);
  });

  // DEXA thresholds
  it('accepts dexa for age 50', () => {
    expect(isScreeningEligible('dexa', 50)).toBe(true);
  });

  it('rejects dexa for age 45', () => {
    expect(isScreeningEligible('dexa', 45)).toBe(false);
  });
});
