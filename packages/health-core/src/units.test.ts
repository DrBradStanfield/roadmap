import { describe, it, expect } from 'vitest';
import { refHintFor } from './reference-hints';
import {
  resolveUnitSystem,
  reportedToCanonical,
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
  CANONICAL_UNITS,
  LIPID_TREATMENT_TARGETS,
  formatTargetLine,
  formatGradedValue,
  waistToHeightRatio,
  isWaistToHeightElevated,
  elevatedWaistFromCm,
  type MetricType,
  type UnitSystem,
} from './units';
import { METRIC_TYPES } from './validation';

describe('Unit conversions — round-trip accuracy', () => {
  const metrics: MetricType[] = [
    'height', 'weight', 'waist', 'hba1c', 'ldl', 'total_cholesterol', 'hdl',
    'triglycerides', 'systolic_bp', 'diastolic_bp', 'apob', 'creatinine', 'lpa',
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

// Lp(a): the ~2.4 mass→molar factor is per mg/dL (EAS 2022 consensus pairs
// 300 mg/dL with 750 nmol/L). NZ/AU labs print mg/L, a tenth of that, so the
// conventional label converts at 0.24. Found live 2026-09-07: 93 mg/L had been
// stored as 223 nmol/L (10× high), which fired `lpa-elevated` on a normal result.
describe('Lp(a) mass → molar conversion (per mg/dL, not per mg/L)', () => {
  it('93 mg/L (the NZ print) → ~22.3 nmol/L', () => {
    expect(toCanonicalValue('lpa', 93, 'conventional')).toBeCloseTo(22.32, 2);
    expect(reportedToCanonical('lpa', 93, 'mg/L')!.valueSI).toBeCloseTo(22.32, 2);
  });

  it('45 mg/dL (the US print, via the scaled alias) → 108 nmol/L, inside the 750 nmol/L range', () => {
    const r = reportedToCanonical('lpa', 45, 'mg/dL')!;
    expect(r.system).toBe('conventional');
    expect(r.valueSI).toBeCloseTo(108, 5);
    expect(r.valueSI).toBeLessThan(UNIT_DEFS.lpa.validationRange.si.max);
  });

  it('nmol/L passes through untouched in both directions', () => {
    expect(toCanonicalValue('lpa', 125, 'si')).toBe(125);
    expect(fromCanonicalValue('lpa', 125, 'si')).toBe(125);
    expect(reportedToCanonical('lpa', 125, 'nmol/L')).toEqual({ valueSI: 125, system: 'si' });
  });

  it('displays a stored 22.32 nmol/L as the 93 mg/L that was entered', () => {
    expect(formatDisplayValue('lpa', 22.32, 'conventional')).toBe('93');
    expect(formatDisplayValue('lpa', 22.32, 'si')).toBe('22');
  });

  it('the conventional validation bound is the canonical 750 nmol/L bound, converted', () => {
    const { si, conventional } = UNIT_DEFS.lpa.validationRange;
    expect(toCanonicalValue('lpa', conventional.max, 'conventional')).toBeCloseTo(si.max, 5);
    expect(getDisplayRange('lpa', 'conventional')).toEqual({ min: 0, max: conventional.max });
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

describe('resolveUnitSystem — no-regression sweep over every metric', () => {
  it('resolves both of a metric\u2019s own labels to the system that converts them', () => {
    for (const metric of METRIC_TYPES) {
      const def = UNIT_DEFS[metric as MetricType];
      expect([metric, resolveUnitSystem(metric as MetricType, def.label.si)]).toEqual([metric, 'si']);
      // Three metrics (mmHg, ng/mL) label both systems the same; SI wins, and the
      // two conversions are identical, so nothing is scaled differently.
      const expected = def.label.si === def.label.conventional ? 'si' : 'conventional';
      expect([metric, resolveUnitSystem(metric as MetricType, def.label.conventional)]).toEqual([metric, expected]);
    }
  });

  it('refuses a unit that belongs to no system, rather than guessing', () => {
    expect(resolveUnitSystem('weight', 'stone')).toBeNull();
    expect(resolveUnitSystem('ldl', 'g/L')).toBeNull();
    expect(resolveUnitSystem('ldl', '')).toBeNull();
  });
});

describe('US-32 AC37 — the spellings of pounds every writer accepts', () => {
  it('reads "lb", "pound" and "pounds" as the label "lbs" already reads', () => {
    const lbs = reportedToCanonical('weight', 180, 'lbs');
    for (const spelling of ['lb', 'pound', 'pounds', 'LB', ' Pounds ']) {
      expect([spelling, reportedToCanonical('weight', 180, spelling)]).toEqual([spelling, lbs]);
    }
  });

  it('accepts those spellings for weight alone', () => {
    for (const metric of METRIC_TYPES.filter((m) => m !== 'weight')) {
      for (const spelling of ['lb', 'pound', 'pounds']) {
        expect([metric, spelling, reportedToCanonical(metric as MetricType, 1, spelling)]).toEqual([metric, spelling, null]);
      }
    }
  });
});

describe('US-32 AC35 — the SI unit every stored measurement is in', () => {
  it('names one canonical unit per metric, the unit definition\u2019s own', () => {
    for (const metric of METRIC_TYPES) {
      expect([metric, CANONICAL_UNITS[metric as MetricType]]).toEqual([metric, UNIT_DEFS[metric as MetricType].canonical]);
    }
    expect(CANONICAL_UNITS.weight).toBe('kg');
    // Every metric with a unit definition, height included: it is a profile
    // field, so METRIC_TYPES does not list it, but a read still states its unit.
    expect(Object.keys(CANONICAL_UNITS).sort()).toEqual(Object.keys(UNIT_DEFS).sort());
  });
});

// US-07 AC5: a "<X" target prints the first value, at the unit's display step,
// that the plan grades at or past the line, so a displayed value on either
// side of X reads the way the plan grades it.
describe('formatTargetLine (US-07 AC5, US-06 AC5)', () => {
  it.each([
    ['LDL 1.4 mmol/L', 'ldl', LIPID_TREATMENT_TARGETS.ldlMmol, '1.4', '55'], // 54 mg/dL is 1.396: below the target
    ['non-HDL 1.6 mmol/L', 'ldl', LIPID_TREATMENT_TARGETS.nonHdlMmol, '1.6', '62'], // 61 mg/dL is 1.577
    ['ApoB 0.5 g/L', 'apob', LIPID_TREATMENT_TARGETS.apobGl, '0.50', '50'],
  ] as const)('%s (%s at %s) prints %s in SI and %s in US units', (_name, metric, line, si, conv) => {
    expect(formatTargetLine(metric, line, 'si')).toBe(si);
    expect(formatTargetLine(metric, line, 'conventional')).toBe(conv);
  });

  it('the printed value is at or above the line, and one display step below it is not', () => {
    for (const metric of ['ldl', 'apob'] as MetricType[]) {
      for (const line of [0.5, 1.4, 1.6, 130 / 38.67, 160 / 38.67, 190 / 38.67]) {
        for (const unit of ['si', 'conventional'] as const) {
          const step = 10 ** -UNIT_DEFS[metric].decimalPlaces[unit];
          const x = Number(formatTargetLine(metric, line, unit));
          expect(toCanonicalValue(metric, x, unit), `${metric} ${line} ${unit}`).toBeGreaterThanOrEqual(line);
          expect(toCanonicalValue(metric, x - step, unit), `${metric} ${line} ${unit}`).toBeLessThan(line);
        }
      }
    }
  });

  it('takes the plan\'s own test when the grade is not a plain comparison', () => {
    // A waist the plan grades elevated at 178 cm: its ratio rounds to 0.50 from 88.11 cm.
    const elevated = (cm: number) => Math.round((cm / 178) * 100) / 100 >= 0.5;
    expect(formatTargetLine('waist', 0.495 * 178, 'si', elevated)).toBe('89');
    expect(formatTargetLine('waist', 0.495 * 178, 'conventional', elevated)).toBe('34.7');
  });
});

// US-07 AC5, US-06 AC5: a line that is not a finite number (a NaN height makes
// a NaN waist line) has no first step past it. The walk used to loop forever
// and hang the page; it now prints the line as formatDisplayValue does, and a
// value beside it prints plain.
describe('formatTargetLine on a line that is not finite (US-07 AC5, US-06 AC5)', () => {
  it.each([NaN, Infinity, -Infinity])('returns for a line of %s', (line) => {
    expect(formatTargetLine('ldl', line, 'si')).toBe(formatDisplayValue('ldl', line, 'si'));
    expect(formatTargetLine('waist', line, 'conventional', (v) => v > line)).toBe(formatDisplayValue('waist', line, 'conventional'));
    expect(formatGradedValue('ldl', 1.4, 'conventional', line)).toBe('54');
  });
});

// US-07 AC5, US-06 AC5: a value printed beside its "<X" line reads on the side
// of X the plan grades it. Rounded to the nearest display step, a value off the
// display grid (typed in the other unit) could land on the wrong side: 1.40
// mmol/L of LDL is 54.1 mg/dL beside "<55", and 54 mg/dL is 1.396 mmol/L,
// "1.4" beside "<1.4". Graded at or past the line, such a value shows X;
// graded below it, one more decimal place, rounded down.
describe('formatGradedValue (US-07 AC5, US-06 AC5)', () => {
  const T = LIPID_TREATMENT_TARGETS;
  const ldlMg = (mg: number) => toCanonicalValue('ldl', mg, 'conventional');

  it('LDL 1.40 mmol/L, graded at the target, shows 55 mg/dL, not 54', () => {
    expect(formatGradedValue('ldl', 1.4, 'conventional', T.ldlMmol)).toBe('55');
  });

  it('LDL 54 mg/dL (1.3964), graded below the target, shows 1.39 mmol/L, not 1.4', () => {
    expect(formatGradedValue('ldl', ldlMg(54), 'si', T.ldlMmol)).toBe('1.39');
    for (const [v, shown] of [[1.36, '1.36'], [1.38, '1.38'], [1.39, '1.39'], [1.395, '1.39'], [1.3999, '1.39']] as const) {
      expect(formatGradedValue('ldl', v, 'si', T.ldlMmol), `${v}`).toBe(shown);
    }
  });

  it('non-HDL 1.56 (total 3.76, HDL 2.20) shows 1.56, below the 1.6 line', () => {
    expect(formatGradedValue('ldl', 1.56, 'si', T.nonHdlMmol)).toBe('1.56');
  });

  it('a waist typed in cm, shown in inches, reads on its graded side of the line', () => {
    // 178 cm: the plan grades 88.11 cm and up elevated; the label is "<34.7 in".
    const graded = (cm: number) => isWaistToHeightElevated(waistToHeightRatio(cm, 178));
    const line = elevatedWaistFromCm(178);
    expect(formatTargetLine('waist', line, 'conventional', graded)).toBe('34.7');
    expect(formatDisplayValue('waist', 88.1, 'conventional')).toBe('34.7'); // healthy, yet at the label
    expect(formatGradedValue('waist', 88.1, 'conventional', line, graded)).toBe('34.68');
    expect(formatGradedValue('waist', 88.11, 'conventional', line, graded)).toBe('34.7');
  });

  it('a value on the display grid shows as it always has', () => {
    for (const [metric, line] of [['ldl', T.ldlMmol], ['ldl', T.nonHdlMmol], ['apob', T.apobGl]] as const) {
      for (const unit of ['si', 'conventional'] as UnitSystem[]) {
        const dp = UNIT_DEFS[metric].decimalPlaces[unit];
        const center = Math.round(fromCanonicalValue(metric, line, unit) * 10 ** dp);
        for (let k = center - 30; k <= center + 30; k++) {
          const v = toCanonicalValue(metric, k / 10 ** dp, unit);
          expect(formatGradedValue(metric, v, unit, line), `${metric} ${k} ${unit}`).toBe(formatDisplayValue(metric, v, unit));
        }
      }
    }
  });

  /** Every value near the line, from a fine sweep and from both units' grids. */
  function near(metric: MetricType, line: number): number[] {
    const values: number[] = [];
    for (let i = -500; i <= 500; i++) values.push(line * (1 + i / 5000));
    for (const unit of ['si', 'conventional'] as UnitSystem[]) {
      const dp = UNIT_DEFS[metric].decimalPlaces[unit] + 1; // one decimal finer than shown
      const center = Math.round(fromCanonicalValue(metric, line, unit) * 10 ** dp);
      for (let k = center - 300; k <= center + 300; k++) values.push(toCanonicalValue(metric, k / 10 ** dp, unit));
    }
    return values;
  }

  /** Rounded as usual; else, graded below the line, one more decimal place
   *  and at most one fine step under the true value; else, graded at or past
   *  it, at most one display step over it. */
  function expectClose(metric: MetricType, v: number, unit: UnitSystem, shown: string, past: boolean) {
    const dp = UNIT_DEFS[metric].decimalPlaces[unit];
    const off = Number(shown) - fromCanonicalValue(metric, v, unit);
    const why = `${metric} ${v} in ${unit}: ${shown}`;
    if (shown === formatDisplayValue(metric, v, unit)) return;
    if (past) {
      expect(off, why).toBeGreaterThanOrEqual(0);
      expect(off, why).toBeLessThanOrEqual(10 ** -dp + 1e-9);
    } else {
      expect(shown.split('.')[1]?.length ?? 0, why).toBe(dp + 1);
      expect(off, why).toBeLessThanOrEqual(1e-9);
      expect(-off, why).toBeLessThan(10 ** -(dp + 1) + 1e-9);
    }
  }

  it('no displayed lipid value contradicts its grade, in either unit, around each line', () => {
    for (const [metric, line] of [['ldl', T.ldlMmol], ['ldl', T.nonHdlMmol], ['apob', T.apobGl]] as const) {
      for (const unit of ['si', 'conventional'] as UnitSystem[]) {
        const x = Number(formatTargetLine(metric, line, unit));
        for (const v of near(metric, line)) {
          const text = formatGradedValue(metric, v, unit, line);
          expect(Number(text) >= x, `${metric} ${v} in ${unit}: ${text} beside <${x}`).toBe(v >= line);
          expectClose(metric, v, unit, text, v >= line);
        }
      }
    }
  });

  it('no displayed waist contradicts its grade, in either unit, at any height', () => {
    for (let h = 120; h <= 230; h += 0.5) {
      const graded = (cm: number) => isWaistToHeightElevated(waistToHeightRatio(cm, h));
      const line = elevatedWaistFromCm(h);
      for (const unit of ['si', 'conventional'] as UnitSystem[]) {
        const x = Number(formatTargetLine('waist', line, unit, graded));
        for (const v of near('waist', line)) {
          const text = formatGradedValue('waist', v, unit, line, graded);
          expect(Number(text) >= x, `${h} cm tall, waist ${v} cm in ${unit}: ${text} beside <${x}`).toBe(graded(v));
          expectClose('waist', v, unit, text, graded(v));
        }
      }
    }
  });
});

// US-07 AC5: the reference hints state each lipid target the way the plan's
// cards do: the first value, at the display step, graded above it.
describe('lipid reference hints (US-07 AC5)', () => {
  it.each([
    ['ldl', 'Optimal: <1.4 mmol/L', 'Optimal: <55 mg/dL'],
    ['apob', 'Optimal: <0.50 g/L', 'Optimal: <50 mg/dL'],
  ] as const)('%s', (metric, si, conv) => {
    expect(refHintFor(metric, 'si')).toBe(si);
    expect(refHintFor(metric, 'conventional')).toBe(conv);
  });
});
