/**
 * Exact cut-offs in calculations.ts and units.ts, taken from
 * health_roadmap_algorithm.md (mutation-testing trial, 2026-10-30). Expected
 * values come from the doc's formulas and constants, never from the code:
 * eGFR from the published CKD-EPI 2021 equation, HbA1c lines from the doc's
 * NGSP→IFCC formula, protein from the Peterson IBW formula.
 */
import { describe, it, expect } from 'vitest';
import { calculateEGFR, calculateHealthResults, getHba1cStatus } from './calculations';
import { bpTargetFor } from './units';

// Doc §2: NGSP to IFCC is (NGSP − 2.152) / 0.09148.
const ifcc = (ngsp: number) => (ngsp - 2.152) / 0.09148;

/** CKD-EPI 2021 (Inker, NEJM 2021) in its published min/max form, written
 *  independently of calculateEGFR: 142 × min(Scr/κ,1)^α × max(Scr/κ,1)^−1.200
 *  × 0.9938^age × 1.012 if female. Scr in mg/dL (µmol/L ÷ 88.4). */
function ckdEpi2021(scrUmol: number, age: number, female: boolean): number {
  const scr = scrUmol / 88.4;
  const k = female ? 0.7 : 0.9;
  const a = female ? -0.241 : -0.302;
  const v = 142 * Math.min(scr / k, 1) ** a * Math.max(scr / k, 1) ** -1.2 * 0.9938 ** age;
  return female ? v * 1.012 : v;
}

describe('US-07 AC7: calculateEGFR is CKD-EPI 2021 on both sides of kappa, for both sexes', () => {
  // Hand-checked values of the published equation (age 50):
  // female 53 µmol/L (0.600 mg/dL, below κ 0.7) → 109.3; female 100 µmol/L (1.131 mg/dL) → 59.2;
  // male 62 µmol/L (0.701 mg/dL, below κ 0.9) → 112.2; male 150 µmol/L (1.697 mg/dL) → 48.6.
  const cases: Array<[number, number, 'female' | 'male', number]> = [
    [53, 50, 'female', 109.3],
    [100, 50, 'female', 59.2],
    [62, 50, 'male', 112.2],
    [150, 50, 'male', 48.6],
  ];
  for (const [cr, age, sex, expected] of cases) {
    it(`${sex}, creatinine ${cr} µmol/L, age ${age}: ${expected}`, () => {
      expect(calculateEGFR(cr, age, sex)).toBeCloseTo(expected, 1);
      expect(calculateEGFR(cr, age, sex)).toBeCloseTo(ckdEpi2021(cr, age, sex === 'female'), 6);
    });
  }

  it('the female factor 1.012 applies to women only', () => {
    // Same creatinine above both kappas, so only the sex factor and kappa differ.
    const ratio = calculateEGFR(150, 60, 'female') / ckdEpi2021(150, 60, false);
    expect(ratio).toBeCloseTo(1.012 * (0.7 / 0.9) ** 1.2, 6);
  });

  it('the plan rounds the calculated eGFR to a whole number (doc §1)', () => {
    const r = calculateHealthResults(
      { heightCm: 175, sex: 'female', birthYear: 1976, birthMonth: 1, creatinine: 100 },
      'si', undefined, undefined, undefined, new Date(2026, 5, 15),
    );
    expect(r.age).toBe(50);
    expect(r.eGFR).toBe(59);
  });
});

describe('US-07 AC1: HbA1c status at the exact 5.7% and 6.5% lines (doc §3, >=)', () => {
  it('6.5% is Diabetic; just below is Prediabetic', () => {
    expect(getHba1cStatus(ifcc(6.5))).toBe('Diabetic');
    expect(getHba1cStatus(ifcc(6.5) - 0.01)).toBe('Prediabetic');
  });

  it('5.7% is Prediabetic; just below is Normal', () => {
    expect(getHba1cStatus(ifcc(5.7))).toBe('Prediabetic');
    expect(getHba1cStatus(ifcc(5.7) - 0.01)).toBe('Normal');
  });
});

describe('US-07 AC7: the CKD protein cut is strict: eGFR exactly 45 keeps 1.2 g/kg (doc §1)', () => {
  // Peterson IBW, male 175 cm: 2.2 × 24 + 3.5 × 24 × 0.25 = 73.8 kg.
  const base = { heightCm: 175, sex: 'male' as const, birthYear: 1976, birthMonth: 1 };
  const now = new Date(2026, 5, 15);

  it('eGFR 45: round(73.8 × 1.2) = 89 g', () => {
    expect(calculateHealthResults({ ...base, labEgfr: 45 }, 'si', undefined, undefined, undefined, now).proteinTarget).toBe(89);
  });

  it('eGFR 44: round(73.8 × 1.0) = 74 g', () => {
    expect(calculateHealthResults({ ...base, labEgfr: 44 }, 'si', undefined, undefined, undefined, now).proteinTarget).toBe(74);
  });

  it('a lab eGFR of 44.6 rounds to 45 first, so 1.2 g/kg', () => {
    const r = calculateHealthResults({ ...base, labEgfr: 44.6 }, 'si', undefined, undefined, undefined, now);
    expect(r.eGFR).toBe(45);
    expect(r.proteinTarget).toBe(89);
  });
});

describe('US-07 AC5: non-HDL needs both total cholesterol and HDL', () => {
  const base = { heightCm: 175, sex: 'male' as const };

  it('total cholesterol alone, or HDL alone, gives no non-HDL', () => {
    expect(calculateHealthResults({ ...base, totalCholesterol: 5.0 }).nonHdlCholesterol).toBeUndefined();
    expect(calculateHealthResults({ ...base, hdlC: 1.2 }).nonHdlCholesterol).toBeUndefined();
  });

  it('both: total − HDL, unrounded past float noise (3.80 − 2.20 = 1.6)', () => {
    expect(calculateHealthResults({ ...base, totalCholesterol: 3.8, hdlC: 2.2 }).nonHdlCholesterol).toBe(1.6);
  });

  it('HDL equal to total (non-HDL 0) is a data-entry error and stores no non-HDL', () => {
    // Doc §1 gives only the formula; the zero/negative guard is the code's
    // (calculations.ts comment). Pinned here and reported as "doc silent".
    expect(calculateHealthResults({ ...base, totalCholesterol: 4.0, hdlC: 4.0 }).nonHdlCholesterol).toBeUndefined();
  });
});

describe('US-07 AC1: the BP target turns at exactly 65 (doc §3: < 120/80 under 65, < 130/80 at 65 or older)', () => {
  it('64 → 120, 65 → 130, 66 → 130, unknown age → 120', () => {
    expect(bpTargetFor(64)).toBe(120);
    expect(bpTargetFor(65)).toBe(130);
    expect(bpTargetFor(66)).toBe(130);
    expect(bpTargetFor(undefined)).toBe(120);
  });
});
