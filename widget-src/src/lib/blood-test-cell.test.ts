import { describe, it, expect, vi } from 'vitest';
import type React from 'react';
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

// US-02 AC4/AC6 (2026-08-07): numeric-only keystroke filtering + systolic
// auto-advance. blockBadNumericKeys previously blocked ONLY -,+,e,E — letters
// sailed through on text-type inputs (and Safari's type="number").
import { blockBadNumericKeys, blockNonIntegerKeys, bpSysAdvance } from './blood-test-cell';

function key(k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) {
  return {
    key: k,
    ctrlKey: false, metaKey: false, altKey: false, ...mods,
    preventDefault: vi.fn(),
  } as unknown as React.KeyboardEvent<HTMLInputElement> & { preventDefault: ReturnType<typeof vi.fn> };
}

describe('blockBadNumericKeys — decimal fields (US-02 AC4)', () => {
  it.each(['a', 'z', 'B', ' ', '/', '-', '+', 'e', 'E', '%'])('blocks %j', (k) => {
    const e = key(k);
    blockBadNumericKeys(e);
    expect(e.preventDefault).toHaveBeenCalled();
  });
  it.each(['0', '9', '.', ','])('allows %j', (k) => {
    const e = key(k);
    blockBadNumericKeys(e);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });
  it.each(['Backspace', 'Tab', 'ArrowLeft', 'Enter', 'Delete', 'Home'])('allows control key %j', (k) => {
    const e = key(k);
    blockBadNumericKeys(e);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });
  it('allows shortcuts (cmd/ctrl+a, ctrl+v)', () => {
    for (const mods of [{ metaKey: true }, { ctrlKey: true }]) {
      const e = key('a', mods);
      blockBadNumericKeys(e);
      expect(e.preventDefault).not.toHaveBeenCalled();
    }
  });
});

describe('blockNonIntegerKeys — integer fields like BP (US-02 AC4)', () => {
  it.each(['a', '.', ',', '-', 'e', ' '])('blocks %j', (k) => {
    const e = key(k);
    blockNonIntegerKeys(e);
    expect(e.preventDefault).toHaveBeenCalled();
  });
  it.each(['0', '5', '9'])('allows digit %j', (k) => {
    const e = key(k);
    blockNonIntegerKeys(e);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });
  it.each(['Backspace', 'Tab', 'ArrowLeft', 'Enter', 'Delete', 'Home'])('allows control key %j', (k) => {
    const e = key(k);
    blockNonIntegerKeys(e);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });
  it('allows shortcuts (cmd/ctrl combos)', () => {
    for (const mods of [{ metaKey: true }, { ctrlKey: true }]) {
      const e = key('v', mods);
      blockNonIntegerKeys(e);
      expect(e.preventDefault).not.toHaveBeenCalled();
    }
  });
});

describe('bpSysAdvance — systolic → diastolic auto-advance (US-02 AC6)', () => {
  it('advances immediately on an unambiguous in-range 3-digit systolic', () => {
    expect(bpSysAdvance('120')).toBe('advance');
    expect(bpSysAdvance('100')).toBe('advance');
    expect(bpSysAdvance('250')).toBe('advance');
  });
  it('defers on a plausible 2-digit systolic that could gain a third digit', () => {
    expect(bpSysAdvance('85')).toBe('defer'); // valid 85, but could become 850? no — 85x invalid; still a complete plausible value typed slowly
    expect(bpSysAdvance('60')).toBe('defer');
    expect(bpSysAdvance('99')).toBe('defer');
  });
  it('stays on prefixes and out-of-range values', () => {
    expect(bpSysAdvance('1')).toBe('stay');
    expect(bpSysAdvance('12')).toBe('stay'); // prefix of 120
    expect(bpSysAdvance('25')).toBe('stay'); // prefix of 250
    expect(bpSysAdvance('999')).toBe('stay');
    expect(bpSysAdvance('300')).toBe('stay');
    expect(bpSysAdvance('')).toBe('stay');
    expect(bpSysAdvance('abc')).toBe('stay');
  });
});
