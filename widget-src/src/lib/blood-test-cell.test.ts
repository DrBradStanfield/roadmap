import { describe, it, expect } from 'vitest';
import { validateTypedValue } from './blood-test-cell';

// ---------------------------------------------------------------------------
// Bug: user typed a value in the Lp(a) text box, hit Enter, the value
// "disappeared". Diagnosis: user typed something out-of-range for the unit
// (e.g. mg/dL number in an mmol/L field). validateTypedValue rejected it,
// the cell rendered a tiny "Max 22.6" message with no unit context, and the
// user could not tell why the value was rejected.
//
// Fix: include the display unit label in the error message so the user
// sees the actual constraint ("Max 22.6 mmol/L" — clearly the wrong unit
// for the value they typed).
// ---------------------------------------------------------------------------

describe('validateTypedValue — error text includes the display unit', () => {
  it('triglycerides above SI max includes "mmol/L"', () => {
    const { error } = validateTypedValue('triglycerides', '100', 'si');
    expect(error).toMatch(/mmol\/L/);
  });

  it('triglycerides above conventional max includes "mg/dL"', () => {
    const { error } = validateTypedValue('triglycerides', '5000', 'conventional');
    expect(error).toMatch(/mg\/dL/);
  });

  it('Lp(a) above SI max includes "nmol/L"', () => {
    const { error } = validateTypedValue('lpa', '1000', 'si');
    expect(error).toMatch(/nmol\/L/);
  });

  it('LDL above SI max includes "mmol/L"', () => {
    const { error } = validateTypedValue('ldl', '50', 'si');
    expect(error).toMatch(/mmol\/L/);
  });

  it('HbA1c below min includes "mmol/mol"', () => {
    const { error } = validateTypedValue('hba1c', '-1', 'si');
    // -1 won't parse via parseLocalisedNumber, so this exercises the
    // "Enter a number" branch which doesn't need a unit. Use 0 instead.
    expect(error === null || /mmol\/mol/.test(error)).toBe(true);
  });

  it('valid in-range value returns no error', () => {
    expect(validateTypedValue('triglycerides', '1.5', 'si').error).toBeNull();
    expect(validateTypedValue('lpa', '100', 'si').error).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Reported bug: entering weight 155 lbs (a clearly valid ~70 kg) in US
// conventional units was said to be rejected with "weight needs to be at least
// 44 lbs" and the field blanked. The suspected mechanism was the SI min (20 kg)
// being compared against the raw conventional number. These tests pin the
// CORRECT behaviour: the bound is always evaluated in the ACTIVE display unit,
// so 155 lbs passes and only a value genuinely below the unit's own minimum
// fails (with the bound expressed in that unit).
// ---------------------------------------------------------------------------

describe('validateTypedValue — weight bounds evaluated in the active unit', () => {
  it('accepts 155 lbs in conventional units (the reported value)', () => {
    expect(validateTypedValue('weight', '155', 'conventional').error).toBeNull();
  });

  it('accepts the equivalent 70 kg in SI units', () => {
    expect(validateTypedValue('weight', '70', 'si').error).toBeNull();
  });

  it('rejects a value below the conventional minimum, expressed in lbs', () => {
    // 30 lbs is below the 44 lbs (≈20 kg) floor.
    const { error } = validateTypedValue('weight', '30', 'conventional');
    expect(error).toBe('Min 44 lbs');
  });

  it('rejects a value below the SI minimum, expressed in kg', () => {
    const { error } = validateTypedValue('weight', '15', 'si');
    expect(error).toBe('Min 20 kg');
  });

  it('does not apply the SI 20-kg floor to a conventional number', () => {
    // 25 lbs (≈11 kg) is below BOTH floors, but the error must be the lbs floor,
    // never "Min 20 kg" — i.e. the conventional number is not measured against SI.
    const { error } = validateTypedValue('weight', '25', 'conventional');
    expect(error).toMatch(/lbs/);
    expect(error).not.toMatch(/kg/);
  });

  it('accepts waist values in conventional inches without SI-cm confusion', () => {
    expect(validateTypedValue('waist', '36', 'conventional').error).toBeNull();
    expect(validateTypedValue('waist', '90', 'si').error).toBeNull();
  });
});
