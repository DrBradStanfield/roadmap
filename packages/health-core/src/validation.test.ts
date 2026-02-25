import { describe, it, expect } from 'vitest';
import { convertValidationErrorsToUnits, medicationSchema, screeningSchema, profileUpdateSchema, measurementSchema, validateInputValue, isBirthYearClearlyInvalid } from './validation';

// ---------------------------------------------------------------------------
// Client-side input validation (identity fields only — no unit conversion)
// ---------------------------------------------------------------------------

describe('validateInputValue', () => {
  // Birth year bug reproduction: user entered 2980
  it('rejects birth year 2980 (reported bug)', () => {
    expect(validateInputValue('birthYear', 2980)).toBeUndefined();
  });

  it('rejects birth year in the future', () => {
    expect(validateInputValue('birthYear', new Date().getFullYear() + 1)).toBeUndefined();
  });

  it('accepts valid birth year', () => {
    expect(validateInputValue('birthYear', 1985)).toBe(1985);
  });

  it('rejects birth year below 1900', () => {
    expect(validateInputValue('birthYear', 1800)).toBeUndefined();
  });

  it('accepts current year as birth year (boundary)', () => {
    expect(validateInputValue('birthYear', new Date().getFullYear())).toBe(new Date().getFullYear());
  });

  it('accepts 1900 as birth year (boundary)', () => {
    expect(validateInputValue('birthYear', 1900)).toBe(1900);
  });

  // Blood pressure
  it('rejects systolic BP above max (250)', () => {
    expect(validateInputValue('systolicBp', 300)).toBeUndefined();
  });

  it('accepts systolic BP within range', () => {
    expect(validateInputValue('systolicBp', 120)).toBe(120);
  });

  it('accepts systolic BP at boundaries', () => {
    expect(validateInputValue('systolicBp', 60)).toBe(60);
    expect(validateInputValue('systolicBp', 250)).toBe(250);
  });

  it('rejects diastolic BP below min (40)', () => {
    expect(validateInputValue('diastolicBp', 20)).toBeUndefined();
  });

  it('accepts diastolic BP within range', () => {
    expect(validateInputValue('diastolicBp', 80)).toBe(80);
  });

  it('accepts diastolic BP at boundaries', () => {
    expect(validateInputValue('diastolicBp', 40)).toBe(40);
    expect(validateInputValue('diastolicBp', 150)).toBe(150);
  });

  // PSA
  it('rejects PSA above max (100)', () => {
    expect(validateInputValue('psa', 150)).toBeUndefined();
  });

  it('accepts PSA within range', () => {
    expect(validateInputValue('psa', 2.5)).toBe(2.5);
  });

  it('accepts PSA at boundaries', () => {
    expect(validateInputValue('psa', 0)).toBe(0);
    expect(validateInputValue('psa', 100)).toBe(100);
  });

  // Edge cases
  it('returns undefined for undefined value', () => {
    expect(validateInputValue('birthYear', undefined)).toBeUndefined();
  });

  it('returns value as-is for unknown fields (no range defined)', () => {
    expect(validateInputValue('unknownField', 99999)).toBe(99999);
  });
});

describe('isBirthYearClearlyInvalid', () => {
  it('returns true for 4-digit year exceeding current year (2980)', () => {
    expect(isBirthYearClearlyInvalid(2980)).toBe(true);
  });

  it('returns false for partial years (2-3 digits)', () => {
    expect(isBirthYearClearlyInvalid(29)).toBe(false);
    expect(isBirthYearClearlyInvalid(298)).toBe(false);
  });

  it('returns false for valid 4-digit year', () => {
    expect(isBirthYearClearlyInvalid(1985)).toBe(false);
  });

  it('returns false for current year', () => {
    expect(isBirthYearClearlyInvalid(new Date().getFullYear())).toBe(false);
  });

  it('returns true for 5-digit number', () => {
    expect(isBirthYearClearlyInvalid(29800)).toBe(true);
  });
});

describe('convertValidationErrorsToUnits', () => {
  describe('SI unit system (no conversion)', () => {
    it('returns errors unchanged when unitSystem is si', () => {
      const errors = {
        weightKg: 'Weight must be at least 20 kg',
        heightCm: 'Height must be at least 50 cm',
      };
      const result = convertValidationErrorsToUnits(errors, 'si');
      expect(result).toEqual(errors);
    });
  });

  describe('Conventional (US) unit system', () => {
    it('converts weight from kg to lbs', () => {
      const errors = { weightKg: 'Weight must be at least 20 kg' };
      const result = convertValidationErrorsToUnits(errors, 'conventional');
      expect(result.weightKg).toBe('Weight must be at least 44 lbs');
    });

    it('converts weight max from kg to lbs', () => {
      const errors = { weightKg: 'Weight must be at most 300 kg' };
      const result = convertValidationErrorsToUnits(errors, 'conventional');
      expect(result.weightKg).toBe('Weight must be at most 661 lbs');
    });

    it('converts height from cm to inches', () => {
      const errors = { heightCm: 'Height must be at least 50 cm' };
      const result = convertValidationErrorsToUnits(errors, 'conventional');
      expect(result.heightCm).toBe('Height must be at least 19.7 in');
    });

    it('converts height max from cm to inches', () => {
      const errors = { heightCm: 'Height must be at most 250 cm' };
      const result = convertValidationErrorsToUnits(errors, 'conventional');
      expect(result.heightCm).toBe('Height must be at most 98.4 in');
    });

    it('converts waist from cm to inches', () => {
      const errors = { waistCm: 'Waist must be at least 40 cm' };
      const result = convertValidationErrorsToUnits(errors, 'conventional');
      expect(result.waistCm).toBe('Waist must be at least 15.7 in');
    });

    it('converts HbA1c from mmol/mol to %', () => {
      const errors = { hba1c: 'HbA1c must be at least 9 mmol/mol' };
      const result = convertValidationErrorsToUnits(errors, 'conventional');
      // 9 mmol/mol × 0.09148 + 2.152 ≈ 2.97%
      expect(result.hba1c).toContain('%');
      expect(result.hba1c).toMatch(/HbA1c must be at least \d+\.\d %/);
    });

    it('converts LDL from mmol/L to mg/dL', () => {
      const errors = { ldlC: 'LDL-c must be at most 12.9 mmol/L' };
      const result = convertValidationErrorsToUnits(errors, 'conventional');
      // 12.9 × 38.67 ≈ 499
      expect(result.ldlC).toBe('LDL-c must be at most 499 mg/dL');
    });

    it('converts ApoB from g/L to mg/dL', () => {
      const errors = { apoB: 'ApoB must be at most 3 g/L' };
      const result = convertValidationErrorsToUnits(errors, 'conventional');
      // 3 × 100 = 300
      expect(result.apoB).toBe('ApoB must be at most 300 mg/dL');
    });

    it('converts creatinine from µmol/L to mg/dL', () => {
      const errors = { creatinine: 'Creatinine must be at least 10 µmol/L' };
      const result = convertValidationErrorsToUnits(errors, 'conventional');
      // 10 / 88.4 ≈ 0.11
      expect(result.creatinine).toBe('Creatinine must be at least 0.11 mg/dL');
    });

    it('does not convert blood pressure (same units)', () => {
      const errors = { systolicBp: 'Systolic BP must be at least 60 mmHg' };
      const result = convertValidationErrorsToUnits(errors, 'conventional');
      expect(result.systolicBp).toBe('Systolic BP must be at least 60 mmHg');
    });
  });

  describe('Unknown fields', () => {
    it('returns unknown fields unchanged', () => {
      const errors = { unknownField: 'Some error message' };
      const result = convertValidationErrorsToUnits(errors, 'conventional');
      expect(result.unknownField).toBe('Some error message');
    });
  });

  describe('Multiple errors', () => {
    it('converts multiple errors correctly', () => {
      const errors = {
        weightKg: 'Weight must be at least 20 kg',
        heightCm: 'Height must be at least 50 cm',
        ldlC: 'LDL-c must be at most 12.9 mmol/L',
      };
      const result = convertValidationErrorsToUnits(errors, 'conventional');

      expect(result.weightKg).toBe('Weight must be at least 44 lbs');
      expect(result.heightCm).toBe('Height must be at least 19.7 in');
      expect(result.ldlC).toBe('LDL-c must be at most 499 mg/dL');
    });
  });

  describe('Edge cases', () => {
    it('handles empty errors object', () => {
      const result = convertValidationErrorsToUnits({}, 'conventional');
      expect(result).toEqual({});
    });

    it('handles messages without units', () => {
      const errors = { sex: 'Please select male or female' };
      const result = convertValidationErrorsToUnits(errors, 'conventional');
      expect(result.sex).toBe('Please select male or female');
    });
  });
});

describe('medicationSchema', () => {
  // --- Bug 3 regression test ---
  // Before fix: sync-embed.liquid sent { medicationKey, value } instead of
  // { medicationKey, drugName }. The schema should reject the old format.
  it('rejects old sync-embed format with value instead of drugName (Bug 3)', () => {
    const result = medicationSchema.safeParse({
      medicationKey: 'statin',
      value: 'atorvastatin', // Bug 3: old format used 'value' not 'drugName'
    });
    expect(result.success).toBe(false);
  });

  it('accepts correct FHIR format with drugName', () => {
    const result = medicationSchema.safeParse({
      medicationKey: 'statin',
      drugName: 'atorvastatin',
      doseValue: 20,
      doseUnit: 'mg',
    });
    expect(result.success).toBe(true);
  });

  it('accepts medication status values (none, not_tolerated, not_yet)', () => {
    for (const status of ['none', 'not_tolerated', 'not_yet']) {
      const result = medicationSchema.safeParse({
        medicationKey: 'statin',
        drugName: status,
      });
      expect(result.success).toBe(true);
    }
  });

  it('rejects empty drugName', () => {
    const result = medicationSchema.safeParse({
      medicationKey: 'statin',
      drugName: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing drugName entirely', () => {
    const result = medicationSchema.safeParse({
      medicationKey: 'statin',
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown medication keys', () => {
    const result = medicationSchema.safeParse({
      medicationKey: 'aspirin',
      drugName: 'aspirin',
    });
    expect(result.success).toBe(false);
  });

  it('accepts all valid medication keys', () => {
    const validKeys = ['statin', 'ezetimibe', 'statin_escalation', 'pcsk9i', 'glp1', 'glp1_escalation', 'sglt2i', 'metformin'];
    for (const key of validKeys) {
      const result = medicationSchema.safeParse({
        medicationKey: key,
        drugName: 'test_drug',
      });
      expect(result.success).toBe(true);
    }
  });

  it('accepts nullable doseValue and doseUnit', () => {
    const result = medicationSchema.safeParse({
      medicationKey: 'ezetimibe',
      drugName: 'not_yet',
      doseValue: null,
      doseUnit: null,
    });
    expect(result.success).toBe(true);
  });
});

describe('screeningSchema', () => {
  it('accepts valid screening data', () => {
    const result = screeningSchema.safeParse({
      screeningKey: 'colorectal_method',
      value: 'colonoscopy_10yr',
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty value', () => {
    const result = screeningSchema.safeParse({
      screeningKey: 'colorectal_method',
      value: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown screening keys', () => {
    const result = screeningSchema.safeParse({
      screeningKey: 'unknown_screening',
      value: 'some_value',
    });
    expect(result.success).toBe(false);
  });

  it('rejects value exceeding max length (500 chars)', () => {
    const result = screeningSchema.safeParse({
      screeningKey: 'colorectal_method',
      value: 'a'.repeat(501),
    });
    expect(result.success).toBe(false);
  });

  it('accepts value at max length (500 chars)', () => {
    const result = screeningSchema.safeParse({
      screeningKey: 'colorectal_method',
      value: 'a'.repeat(500),
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// String length limits (security hardening)
// ---------------------------------------------------------------------------

describe('profileUpdateSchema — string length limits', () => {
  it('rejects firstName exceeding 100 chars', () => {
    const result = profileUpdateSchema.safeParse({
      firstName: 'a'.repeat(101),
    });
    expect(result.success).toBe(false);
  });

  it('rejects lastName exceeding 100 chars', () => {
    const result = profileUpdateSchema.safeParse({
      lastName: 'a'.repeat(101),
    });
    expect(result.success).toBe(false);
  });

  it('accepts firstName at 100 chars', () => {
    const result = profileUpdateSchema.safeParse({
      firstName: 'a'.repeat(100),
    });
    expect(result.success).toBe(true);
  });

  it('accepts lastName at 100 chars', () => {
    const result = profileUpdateSchema.safeParse({
      lastName: 'a'.repeat(100),
    });
    expect(result.success).toBe(true);
  });
});

describe('medicationSchema — string length limits', () => {
  it('rejects drugName exceeding 100 chars', () => {
    const result = medicationSchema.safeParse({
      medicationKey: 'statin',
      drugName: 'a'.repeat(101),
    });
    expect(result.success).toBe(false);
  });

  it('accepts drugName at 100 chars', () => {
    const result = medicationSchema.safeParse({
      medicationKey: 'statin',
      drugName: 'a'.repeat(100),
    });
    expect(result.success).toBe(true);
  });

  it('rejects doseUnit exceeding 20 chars', () => {
    const result = medicationSchema.safeParse({
      medicationKey: 'statin',
      drugName: 'atorvastatin',
      doseValue: 10,
      doseUnit: 'a'.repeat(21),
    });
    expect(result.success).toBe(false);
  });

  it('accepts doseUnit at 20 chars', () => {
    const result = medicationSchema.safeParse({
      medicationKey: 'statin',
      drugName: 'atorvastatin',
      doseValue: 10,
      doseUnit: 'a'.repeat(20),
    });
    expect(result.success).toBe(true);
  });
});

describe('measurementSchema — string length limits', () => {
  it('rejects externalId exceeding 200 chars', () => {
    const result = measurementSchema.safeParse({
      metricType: 'weight',
      value: 75,
      externalId: 'a'.repeat(201),
    });
    expect(result.success).toBe(false);
  });

  it('accepts externalId at 200 chars', () => {
    const result = measurementSchema.safeParse({
      metricType: 'weight',
      value: 75,
      externalId: 'a'.repeat(200),
    });
    expect(result.success).toBe(true);
  });
});
