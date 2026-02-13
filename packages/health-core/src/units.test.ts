import { describe, it, expect } from 'vitest';
import {
  toCanonicalValue,
  fromCanonicalValue,
  formatDisplayValue,
  getDisplayLabel,
  getDisplayRange,
  detectUnitSystem,
  UNIT_DEFS,
  HBA1C_THRESHOLDS,
  LDL_THRESHOLDS,
  inchesToFeetInches,
  feetInchesToInches,
  cmToFeetInches,
  feetInchesToCm,
  formatHeightDisplay,
  type MetricType,
} from './units';

describe('Unit conversions — round-trip accuracy', () => {
  const metrics: MetricType[] = [
    'height', 'weight', 'waist', 'hba1c', 'ldl', 'total_cholesterol', 'hdl',
    'triglycerides', 'systolic_bp', 'diastolic_bp', 'apob', 'creatinine',
  ];

  for (const metric of metrics) {
    it(`${metric}: SI round-trip is identity`, () => {
      const value = 100;
      const canonical = toCanonicalValue(metric, value, 'si');
      const back = fromCanonicalValue(metric, canonical, 'si');
      expect(back).toBeCloseTo(value, 5);
    });

    it(`${metric}: conventional round-trip preserves value`, () => {
      const value = 100;
      const canonical = toCanonicalValue(metric, value, 'conventional');
      const back = fromCanonicalValue(metric, canonical, 'conventional');
      expect(back).toBeCloseTo(value, 3);
    });
  }
});

describe('Known clinical value conversions', () => {
  it('weight: 150 lbs → ~68.04 kg', () => {
    const kg = toCanonicalValue('weight', 150, 'conventional');
    expect(kg).toBeCloseTo(68.04, 1);
  });

  it('weight: 70 kg → ~154.3 lbs', () => {
    const lbs = fromCanonicalValue('weight', 70, 'conventional');
    expect(lbs).toBeCloseTo(154.3, 0);
  });

  it('height: 70 inches → 177.8 cm', () => {
    const cm = toCanonicalValue('height', 70, 'conventional');
    expect(cm).toBeCloseTo(177.8, 1);
  });

  it('height: 175 cm → ~68.9 inches', () => {
    const inches = fromCanonicalValue('height', 175, 'conventional');
    expect(inches).toBeCloseTo(68.9, 1);
  });

  it('LDL: 130 mg/dL → ~3.36 mmol/L', () => {
    const mmol = toCanonicalValue('ldl', 130, 'conventional');
    expect(mmol).toBeCloseTo(3.36, 1);
  });

  it('LDL: 2.59 mmol/L → ~100 mg/dL', () => {
    const mgdl = fromCanonicalValue('ldl', 2.59, 'conventional');
    expect(mgdl).toBeCloseTo(100, 0);
  });

  it('triglycerides: 150 mg/dL → ~1.69 mmol/L', () => {
    const mmol = toCanonicalValue('triglycerides', 150, 'conventional');
    expect(mmol).toBeCloseTo(1.69, 1);
  });

  it('HbA1c: 5.7% (NGSP) → ~38.8 mmol/mol (IFCC)', () => {
    const ifcc = toCanonicalValue('hba1c', 5.7, 'conventional');
    expect(ifcc).toBeCloseTo(38.8, 0);
  });

  it('HbA1c: 6.5% (NGSP) → ~47.5 mmol/mol (IFCC)', () => {
    const ifcc = toCanonicalValue('hba1c', 6.5, 'conventional');
    expect(ifcc).toBeCloseTo(47.5, 0);
  });

  it('HbA1c: 48 mmol/mol (IFCC) → ~6.5% (NGSP)', () => {
    const ngsp = fromCanonicalValue('hba1c', 48, 'conventional');
    expect(ngsp).toBeCloseTo(6.54, 1);
  });

  it('BP: same in both systems', () => {
    expect(toCanonicalValue('systolic_bp', 120, 'conventional')).toBe(120);
    expect(fromCanonicalValue('systolic_bp', 120, 'conventional')).toBe(120);
  });
});

describe('Clinical thresholds are correctly defined', () => {
  it('HbA1c prediabetes threshold matches 5.7%', () => {
    const ngsp = fromCanonicalValue('hba1c', HBA1C_THRESHOLDS.prediabetes, 'conventional');
    expect(ngsp).toBeCloseTo(5.7, 1);
  });

  it('HbA1c diabetes threshold matches 6.5%', () => {
    const ngsp = fromCanonicalValue('hba1c', HBA1C_THRESHOLDS.diabetes, 'conventional');
    expect(ngsp).toBeCloseTo(6.5, 1);
  });

  it('LDL borderline threshold matches 130 mg/dL', () => {
    const mgdl = fromCanonicalValue('ldl', LDL_THRESHOLDS.borderline, 'conventional');
    expect(mgdl).toBeCloseTo(130, 0);
  });

});

describe('formatDisplayValue', () => {
  it('formats weight in kg with 1 decimal', () => {
    expect(formatDisplayValue('weight', 70.56, 'si')).toBe('70.6');
  });

  it('formats weight in lbs with 0 decimals', () => {
    expect(formatDisplayValue('weight', 70, 'conventional')).toBe('154');
  });

  it('formats LDL in mmol/L with 1 decimal', () => {
    expect(formatDisplayValue('ldl', 3.362, 'si')).toBe('3.4');
  });

  it('formats LDL in mg/dL with 0 decimals', () => {
    expect(formatDisplayValue('ldl', 3.362, 'conventional')).toBe('130');
  });
});

describe('getDisplayLabel', () => {
  it('returns correct SI labels', () => {
    expect(getDisplayLabel('weight', 'si')).toBe('kg');
    expect(getDisplayLabel('ldl', 'si')).toBe('mmol/L');
    expect(getDisplayLabel('hba1c', 'si')).toBe('mmol/mol');
  });

  it('returns correct conventional labels', () => {
    expect(getDisplayLabel('weight', 'conventional')).toBe('lbs');
    expect(getDisplayLabel('ldl', 'conventional')).toBe('mg/dL');
    expect(getDisplayLabel('hba1c', 'conventional')).toBe('%');
  });
});

describe('getDisplayRange', () => {
  it('returns SI range for weight', () => {
    const range = getDisplayRange('weight', 'si');
    expect(range.min).toBe(20);
    expect(range.max).toBe(300);
  });

  it('returns conventional range for weight', () => {
    const range = getDisplayRange('weight', 'conventional');
    expect(range.min).toBe(44);
    expect(range.max).toBe(661);
  });
});

describe('detectUnitSystem', () => {
  it('returns conventional for en-US in US timezone', () => {
    expect(detectUnitSystem('en-US', 'America/New_York')).toBe('conventional');
  });

  it('returns si for en-NZ', () => {
    expect(detectUnitSystem('en-NZ')).toBe('si');
  });

  it('returns si for en-GB', () => {
    expect(detectUnitSystem('en-GB')).toBe('si');
  });

  it('returns si for en-AU', () => {
    expect(detectUnitSystem('en-AU')).toBe('si');
  });

  it('returns conventional for Liberia (en-LR)', () => {
    expect(detectUnitSystem('en-LR')).toBe('conventional');
  });

  it('returns si for empty locale string', () => {
    // Empty string has no country code to extract
    expect(detectUnitSystem('')).toBe('si');
  });

  it('returns si for language-only locale (no country)', () => {
    expect(detectUnitSystem('en')).toBe('si');
  });

  // Timezone cross-check: en-US locale but non-US timezone
  it('returns si for en-US with NZ timezone', () => {
    expect(detectUnitSystem('en-US', 'Pacific/Auckland')).toBe('si');
  });

  it('returns si for en-US with UK timezone', () => {
    expect(detectUnitSystem('en-US', 'Europe/London')).toBe('si');
  });

  it('returns conventional for en-US with Indiana sub-timezone', () => {
    expect(detectUnitSystem('en-US', 'America/Indiana/Indianapolis')).toBe('conventional');
  });

  it('returns conventional for en-US with Hawaii timezone', () => {
    expect(detectUnitSystem('en-US', 'Pacific/Honolulu')).toBe('conventional');
  });

  it('returns conventional for en-US with Chicago timezone', () => {
    expect(detectUnitSystem('en-US', 'America/Chicago')).toBe('conventional');
  });
});

describe('Feet/inches conversions', () => {
  describe('inchesToFeetInches', () => {
    it('converts 70 inches to 5 ft 10 in', () => {
      expect(inchesToFeetInches(70)).toEqual({ feet: 5, inches: 10 });
    });

    it('converts 72 inches to exactly 6 ft', () => {
      expect(inchesToFeetInches(72)).toEqual({ feet: 6, inches: 0 });
    });

    it('handles fractional inches by rounding', () => {
      expect(inchesToFeetInches(70.4)).toEqual({ feet: 5, inches: 10 });
      expect(inchesToFeetInches(70.6)).toEqual({ feet: 5, inches: 11 });
    });

    it('handles 11.5+ rounding edge case', () => {
      // 59.6 inches = 4 ft 11.6 in, rounds to 5 ft 0 in
      expect(inchesToFeetInches(59.6)).toEqual({ feet: 5, inches: 0 });
    });

    it('handles short heights (less than 1 foot)', () => {
      expect(inchesToFeetInches(10)).toEqual({ feet: 0, inches: 10 });
    });
  });

  describe('feetInchesToInches', () => {
    it('converts 5 ft 10 in to 70 inches', () => {
      expect(feetInchesToInches(5, 10)).toBe(70);
    });

    it('handles just feet (no inches)', () => {
      expect(feetInchesToInches(6, 0)).toBe(72);
    });

    it('handles just inches (no feet)', () => {
      expect(feetInchesToInches(0, 10)).toBe(10);
    });
  });

  describe('cmToFeetInches', () => {
    it('converts 177.8 cm to 5 ft 10 in', () => {
      expect(cmToFeetInches(177.8)).toEqual({ feet: 5, inches: 10 });
    });

    it('converts 152.4 cm to 5 ft 0 in', () => {
      expect(cmToFeetInches(152.4)).toEqual({ feet: 5, inches: 0 });
    });

    it('converts 180 cm to approximately 5 ft 11 in', () => {
      const result = cmToFeetInches(180);
      expect(result.feet).toBe(5);
      expect(result.inches).toBe(11);
    });
  });

  describe('feetInchesToCm', () => {
    it('converts 5 ft 10 in to ~177.8 cm', () => {
      expect(feetInchesToCm(5, 10)).toBeCloseTo(177.8, 1);
    });

    it('converts 6 ft 0 in to ~182.88 cm', () => {
      expect(feetInchesToCm(6, 0)).toBeCloseTo(182.88, 1);
    });
  });

  describe('round-trip accuracy', () => {
    it('cm → feet/inches → cm preserves value within 1 cm', () => {
      const originalCm = 175;
      const { feet, inches } = cmToFeetInches(originalCm);
      const backToCm = feetInchesToCm(feet, inches);
      expect(backToCm).toBeCloseTo(originalCm, 0);
    });
  });

  describe('formatHeightDisplay', () => {
    it('formats SI as cm', () => {
      expect(formatHeightDisplay(177.8, 'si')).toBe('178 cm');
    });

    it('formats conventional as ft/in with prime notation', () => {
      expect(formatHeightDisplay(177.8, 'conventional')).toBe('5\'10"');
    });

    it('handles 6 ft exactly', () => {
      expect(formatHeightDisplay(182.88, 'conventional')).toBe('6\'0"');
    });
  });
});
