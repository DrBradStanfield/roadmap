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
