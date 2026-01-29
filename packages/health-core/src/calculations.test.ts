import { describe, it, expect } from 'vitest';
import {
  calculateIBW,
  calculateProteinTarget,
  calculateBMI,
  calculateWaistToHeight,
  calculateAge,
  getBMICategory,
  calculateHealthResults,
} from './calculations';

describe('calculateIBW (Ideal Body Weight)', () => {
  it('calculates correctly for average height male', () => {
    // 175cm male: 50 + 0.91 * (175 - 152.4) = 50 + 20.566 = 70.566
    const ibw = calculateIBW(175, 'male');
    expect(ibw).toBeCloseTo(70.57, 1);
  });

  it('calculates correctly for average height female', () => {
    // 165cm female: 45.5 + 0.91 * (165 - 152.4) = 45.5 + 11.466 = 56.966
    const ibw = calculateIBW(165, 'female');
    expect(ibw).toBeCloseTo(56.97, 1);
  });

  it('returns minimum of 30kg for very short heights', () => {
    const ibw = calculateIBW(100, 'male');
    expect(ibw).toBe(30);
  });

  it('handles tall male correctly', () => {
    // 190cm male: 50 + 0.91 * (190 - 152.4) = 50 + 34.216 = 84.216
    const ibw = calculateIBW(190, 'male');
    expect(ibw).toBeCloseTo(84.22, 1);
  });

  it('handles exact baseline height', () => {
    // At 152.4cm, should return base weight
    expect(calculateIBW(152.4, 'male')).toBe(50);
    expect(calculateIBW(152.4, 'female')).toBe(45.5);
  });
});

describe('calculateProteinTarget', () => {
  it('calculates 1.2g per kg of IBW', () => {
    expect(calculateProteinTarget(70)).toBe(84);
    expect(calculateProteinTarget(60)).toBe(72);
    expect(calculateProteinTarget(80)).toBe(96);
  });

  it('rounds to nearest whole number', () => {
    // 65.5 * 1.2 = 78.6 -> 79
    expect(calculateProteinTarget(65.5)).toBe(79);
  });
});

describe('calculateBMI', () => {
  it('calculates BMI correctly for normal weight', () => {
    // 70kg, 175cm: 70 / (1.75)^2 = 70 / 3.0625 = 22.86
    const bmi = calculateBMI(70, 175);
    expect(bmi).toBeCloseTo(22.86, 1);
  });

  it('calculates BMI correctly for overweight', () => {
    // 90kg, 175cm: 90 / 3.0625 = 29.39
    const bmi = calculateBMI(90, 175);
    expect(bmi).toBeCloseTo(29.39, 1);
  });

  it('calculates BMI correctly for obese', () => {
    // 100kg, 170cm: 100 / 2.89 = 34.6
    const bmi = calculateBMI(100, 170);
    expect(bmi).toBeCloseTo(34.6, 1);
  });

  it('calculates BMI correctly for underweight', () => {
    // 50kg, 175cm: 50 / 3.0625 = 16.33
    const bmi = calculateBMI(50, 175);
    expect(bmi).toBeCloseTo(16.33, 1);
  });
});

describe('calculateWaistToHeight', () => {
  it('calculates ratio correctly', () => {
    expect(calculateWaistToHeight(80, 175)).toBeCloseTo(0.457, 2);
    expect(calculateWaistToHeight(90, 175)).toBeCloseTo(0.514, 2);
  });

  it('identifies healthy ratio (< 0.5)', () => {
    const ratio = calculateWaistToHeight(80, 170);
    expect(ratio).toBeLessThan(0.5);
  });

  it('identifies elevated ratio (> 0.5)', () => {
    const ratio = calculateWaistToHeight(95, 170);
    expect(ratio).toBeGreaterThan(0.5);
  });
});

describe('calculateAge', () => {
  it('calculates age when birthday has passed this year', () => {
    const currentYear = new Date().getFullYear();
    const currentMonth = new Date().getMonth() + 1;

    // If current month is > 1, use month 1 (January) - birthday has passed
    if (currentMonth > 1) {
      const age = calculateAge(currentYear - 30, 1);
      expect(age).toBe(30);
    }
  });

  it('calculates age when birthday has not passed this year', () => {
    const currentYear = new Date().getFullYear();
    const currentMonth = new Date().getMonth() + 1;

    // If current month is < 12, use month 12 (December) - birthday hasn't passed
    if (currentMonth < 12) {
      const age = calculateAge(currentYear - 30, 12);
      expect(age).toBe(29);
    }
  });

  it('returns 0 for future birth years', () => {
    const futureYear = new Date().getFullYear() + 1;
    expect(calculateAge(futureYear, 1)).toBe(0);
  });
});

describe('getBMICategory', () => {
  it('classifies underweight correctly', () => {
    expect(getBMICategory(16)).toBe('Underweight');
    expect(getBMICategory(18.4)).toBe('Underweight');
  });

  it('classifies normal correctly', () => {
    expect(getBMICategory(18.5)).toBe('Normal');
    expect(getBMICategory(22)).toBe('Normal');
    expect(getBMICategory(24.9)).toBe('Normal');
  });

  it('classifies overweight correctly', () => {
    expect(getBMICategory(25)).toBe('Overweight');
    expect(getBMICategory(27)).toBe('Overweight');
    expect(getBMICategory(29.9)).toBe('Overweight');
  });

  it('classifies obese classes correctly', () => {
    expect(getBMICategory(30)).toBe('Obese (Class I)');
    expect(getBMICategory(35)).toBe('Obese (Class II)');
    expect(getBMICategory(40)).toBe('Obese (Class III)');
    expect(getBMICategory(45)).toBe('Obese (Class III)');
  });
});

describe('calculateHealthResults', () => {
  it('calculates basic results with minimum inputs', () => {
    const results = calculateHealthResults({
      heightCm: 175,
      sex: 'male',
    });

    expect(results.idealBodyWeight).toBeCloseTo(70.6, 0);
    expect(results.proteinTarget).toBe(85);
    expect(results.bmi).toBeUndefined();
    expect(results.waistToHeightRatio).toBeUndefined();
    expect(results.age).toBeUndefined();
    expect(results.suggestions.length).toBeGreaterThan(0);
  });

  it('includes BMI when weight is provided', () => {
    const results = calculateHealthResults({
      heightCm: 175,
      weightKg: 70,
      sex: 'male',
    });

    expect(results.bmi).toBeCloseTo(22.9, 0);
  });

  it('includes waist-to-height when waist is provided', () => {
    const results = calculateHealthResults({
      heightCm: 175,
      waistCm: 85,
      sex: 'male',
    });

    expect(results.waistToHeightRatio).toBeCloseTo(0.49, 1);
  });

  it('includes age when birth info is provided', () => {
    const currentYear = new Date().getFullYear();
    const results = calculateHealthResults({
      heightCm: 175,
      sex: 'male',
      birthYear: currentYear - 35,
      birthMonth: 1,
    });

    // Age should be approximately 35 (depending on current month)
    expect(results.age).toBeGreaterThanOrEqual(34);
    expect(results.age).toBeLessThanOrEqual(35);
  });

  it('rounds BMI to 1 decimal place', () => {
    const results = calculateHealthResults({
      heightCm: 175,
      weightKg: 70,
      sex: 'male',
    });

    const decimalPlaces = (results.bmi!.toString().split('.')[1] || '').length;
    expect(decimalPlaces).toBeLessThanOrEqual(1);
  });

  it('rounds waist-to-height ratio to 2 decimal places', () => {
    const results = calculateHealthResults({
      heightCm: 175,
      waistCm: 85,
      sex: 'male',
    });

    const decimalPlaces = (results.waistToHeightRatio!.toString().split('.')[1] || '').length;
    expect(decimalPlaces).toBeLessThanOrEqual(2);
  });
});
