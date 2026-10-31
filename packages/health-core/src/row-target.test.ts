import { describe, it, expect } from 'vitest';
import { rowTarget, healthyWaistBelow, TARGET_NEEDS_PROFILE } from './row-target';
import { REFERENCE_HINTS } from './reference-hints';
import { getDisplayLabel, isWaistToHeightElevated, toCanonicalValue, waistToHeightRatio, type MetricType, type UnitSystem } from './units';

// US-62 AC9: rowTarget is the one source of a value's target text, for the
// web grids (`full`) and the phone's My data rows (`bare`, no unit).

const adult = {};
const plan = { age: 50, idealBodyWeight: 70, heightCm: 178 };

describe('rowTarget: blood-test reference hints (US-62 AC9)', () => {
  it('prints the grid hint in full and the same target without its unit', () => {
    expect(rowTarget('hba1c', 'conventional', adult, null)).toEqual({ full: 'Normal: <5.7%', bare: 'Normal <5.7' });
    expect(rowTarget('hba1c', 'si', adult, null)).toEqual({ full: 'Normal: <39 mmol/mol', bare: 'Normal <39' });
    expect(rowTarget('ldl', 'si', adult, null)).toEqual({ full: 'Optimal: <1.4 mmol/L', bare: 'Optimal <1.4' });
    expect(rowTarget('apob', 'conventional', adult, null)).toEqual({ full: 'Optimal: <50 mg/dL', bare: 'Optimal <50' });
    expect(rowTarget('triglycerides', 'conventional', adult, null)).toEqual({ full: 'Normal: <150 mg/dL', bare: 'Normal <150' });
  });

  it('every hint, both units, every variant: bare is full without its colon or unit', () => {
    for (const [metric, hint] of Object.entries(REFERENCE_HINTS) as [MetricType, NonNullable<typeof REFERENCE_HINTS[MetricType]>][]) {
      for (const variant of [hint, hint.male, hint.female].filter(Boolean)) {
        for (const [key, system] of [['si', 'si'], ['conv', 'conventional']] as const) {
          const unit = getDisplayLabel(metric, system);
          const full = variant![key];
          const bare = variant!.bare[key];
          expect(bare, `${metric} ${key}`).not.toContain(unit);
          expect(full.replace(': ', ' ').replace(` ${unit}`, '').replace(unit, ''), `${metric} ${key}`).toBe(bare);
        }
      }
    }
  });

  it('picks the sex-specific variant when the sex is known, and the combined one before', () => {
    expect(rowTarget('hdl', 'si', { sex: 'male' }, null)?.bare).toBe('Optimal >1.0');
    expect(rowTarget('hdl', 'conventional', { sex: 'female' }, null)?.bare).toBe('Optimal >50');
    expect(rowTarget('hdl', 'si', adult, null)).toEqual({ full: 'Optimal: >1.0/>1.3 mmol/L', bare: 'Optimal >1.0/>1.3' });
    expect(rowTarget('creatinine', 'si', { sex: 'female' }, null)?.full).toBe('Normal: 45–90 µmol/L');
  });

  it('a test with no target (PSA; eGFR is derived and has no row) answers null', () => {
    expect(rowTarget('psa', 'si', adult, plan)).toBeNull();
  });
});

describe('rowTarget: Lp(a) in its chosen unit (US-05 AC2)', () => {
  it.each([
    ['nmol/L', 'Normal: <75 nmol/L', 'Normal <75'],
    ['mg/dL', 'Normal: <30 mg/dL', 'Normal <30'],
    ['mg/L', 'Normal: <300 mg/L', 'Normal <300'],
  ] as const)('%s', (unit, full, bare) => {
    expect(rowTarget('lpa', unit, adult, null)).toEqual({ full, bare });
  });
});

describe('rowTarget: the plan’s vitals targets (US-06 AC5)', () => {
  it('blood pressure from the plan’s age', () => {
    expect(rowTarget('blood_pressure', 'si', adult, plan)).toEqual({ full: 'Target: <120/80 mmHg', bare: 'Target <120/80' });
    expect(rowTarget('blood_pressure', 'si', adult, { ...plan, age: 70 })?.bare).toBe('Target <130/80');
  });

  it('weight from the ideal body weight, in the field’s unit', () => {
    expect(rowTarget('weight', 'si', adult, plan)).toEqual({ full: 'Target: 70.0 kg', bare: 'Target 70.0' });
    expect(rowTarget('weight', 'conventional', adult, plan)?.full).toMatch(/^Target: [0-9.]+ lbs?$/);
  });

  it('waist from the height, by the plan’s own rule', () => {
    expect(rowTarget('waist', 'si', adult, plan)).toEqual({ full: 'Target: <89 cm', bare: 'Target <89' });
    expect(rowTarget('waist', 'conventional', adult, plan)?.bare).toBe('Target <34.7');
  });

  it('before there is a plan, the grid asks for sex and height and the row prints no target', () => {
    for (const metric of ['blood_pressure', 'weight', 'waist'] as const) {
      expect(rowTarget(metric, 'si', adult, null)).toEqual({ full: TARGET_NEEDS_PROFILE, bare: null });
    }
  });
});

describe('rowTarget: a catalogue test’s printed range', () => {
  it('both sides, one side, none', () => {
    expect(rowTarget({ referenceLow: 135, referenceHigh: 145 }, 'si', adult, null)).toEqual({ full: 'Ref: 135–145', bare: 'Ref 135–145' });
    expect(rowTarget({ referenceLow: null, referenceHigh: 5 }, 'si', adult, null)).toEqual({ full: 'Ref: ––5', bare: 'Ref ≤5' });
    expect(rowTarget({ referenceLow: 40, referenceHigh: null }, 'si', adult, null)).toEqual({ full: 'Ref: 40––', bare: 'Ref ≥40' });
    expect(rowTarget({ referenceLow: null, referenceHigh: null }, 'si', adult, null)).toBeNull();
    expect(rowTarget({}, 'si', adult, null)).toBeNull();
  });
});

// US-07 AC6: a known minor loses only the adult targets.
describe('rowTarget: a known minor (US-07 AC6)', () => {
  it('loses every blood-test hint and the weight and blood-pressure targets', () => {
    for (const metric of ['hba1c', 'ldl', 'hdl', 'apob', 'creatinine', 'triglycerides', 'total_cholesterol'] as const) {
      expect(rowTarget(metric, 'si', null, plan), metric).toBeNull();
    }
    expect(rowTarget('lpa', 'mg/dL', null, plan)).toBeNull();
    expect(rowTarget('weight', 'si', null, plan)).toBeNull();
    expect(rowTarget('blood_pressure', 'si', null, plan)).toBeNull();
    // With no plan either: no "Set sex + height" prompt for a target they will not get.
    expect(rowTarget('weight', 'si', null, null)).toBeNull();
  });

  it('keeps the waist target, which applies to children too, and a lab’s printed range', () => {
    expect(rowTarget('waist', 'si', null, plan)).toEqual({ full: 'Target: <89 cm', bare: 'Target <89' });
    expect(rowTarget('waist', 'si', null, null)?.full).toBe(TARGET_NEEDS_PROFILE);
    expect(rowTarget({ referenceLow: 3, referenceHigh: 5 }, 'si', null, null)?.bare).toBe('Ref 3–5');
  });
});

// US-06 AC5: the matrix's waist label follows the plan's own rule. The plan
// rounds the ratio to 2 decimals, so at 178 cm it turns elevated at 88.11 cm.
// The label prints the first waist, at the display step, that the plan grades
// elevated: 88 cm (0.494) is healthy and 89 cm (0.500) is not, so "<89 cm".
describe('healthyWaistBelow (US-06 AC5)', () => {
  it('at 178 cm reads 89 cm and 34.7 in', () => {
    expect(healthyWaistBelow(178, 'si')).toBe('89');
    expect(healthyWaistBelow(178, 'conventional')).toBe('34.7');
  });

  it('the label is graded elevated and one display step below it is healthy, at any height, in either unit', () => {
    const elevated = (cm: number, h: number) => isWaistToHeightElevated(waistToHeightRatio(cm, h));
    for (let h = 120; h <= 230; h += 0.5) {
      for (const unit of ['si', 'conventional'] as UnitSystem[]) {
        const label = Number(healthyWaistBelow(h, unit));
        const step = unit === 'si' ? 1 : 0.1;
        expect(elevated(toCanonicalValue('waist', label, unit), h), `${h} cm, ${unit}`).toBe(true);
        expect(elevated(toCanonicalValue('waist', label - step, unit), h), `${h} cm, ${unit}`).toBe(false);
      }
    }
  });
});
