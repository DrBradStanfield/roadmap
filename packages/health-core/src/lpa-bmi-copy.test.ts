import { describe, expect, it } from 'vitest';
import { calculateHealthResults } from './calculations';

// US-07 AC1a: the checklist's written target must describe the rule behind its icon.
// This is copy only. Keep the existing BMI / waist exception and thresholds.
describe('Lp(a) BMI target text matches its unchanged classification', () => {
  it.each([
    { name: 'BMI below 25', weightKg: 78, waistCm: undefined, checked: true },
    { name: 'BMI 27 with healthy waist', weightKg: 87.5, waistCm: 80, checked: true },
    { name: 'BMI 27 with elevated waist', weightKg: 87.5, waistCm: 100, checked: false },
    { name: 'BMI 27 without recorded waist', weightKg: 87.5, waistCm: undefined, checked: false },
    { name: 'BMI above 30 with healthy waist', weightKg: 100, waistCm: 80, checked: false },
  ])('$name', ({ weightKg, waistCm, checked }) => {
    const result = calculateHealthResults({
      heightCm: 180, sex: 'male', birthYear: 1980, birthMonth: 1,
      lpa: 150, weightKg, ...(waistCm === undefined ? {} : { waistCm }),
    }, 'si', undefined, undefined, undefined, new Date('2026-10-21T12:00:00Z'));
    const line = result.suggestions.find(s => s.id.includes('lpa'))?.description
      .split('\n').find(text => text.includes('BMI:'));
    expect(line).toBeDefined();
    expect(line?.startsWith(checked ? '✅' : '⚠️')).toBe(true);
    expect(line).toContain('target <25, or <30 with a healthy waist-to-height ratio');
  });
});
