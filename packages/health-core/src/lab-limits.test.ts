/**
 * US-12 AC20: a lab result printed as a limit is saved, and graded only when
 * the bound decides (Brad 2026-11-02, "Only when it decides").
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as units from './units';
import { LAB_CATALOG } from './lab-catalog';
import {
  LIMIT_CUTOFFS, limitDecides, limitRepresentative, readPrintedLimit, withComparator, withRowValue, type LimitField,
} from './lab-limits';
import { sanitizeInputs } from './validation';
import type { HealthInputs } from './types';

const here = dirname(fileURLToPath(import.meta.url));

describe('US-12 AC20 — reading a printed limit', () => {
  it.each([
    ['<5', '<', '5'], ['< 5', '<', '5'], ['≤5', '<=', '5'], ['>60', '>', '60'], ['> 60', '>', '60'], ['≥ 45', '>=', '45'],
  ])('%s is a limit', (text, comparator, rest) => {
    expect(readPrintedLimit(text)).toEqual({ comparator, rest });
  });

  it.each(['<<5', '<=5', '< >5', '<', '> ', '5', '5 <', 'less than 5', '>=60'])('%s is no limit', (text) => {
    expect(readPrintedLimit(text)).toBeNull();
  });

  it('shows ≤ and ≥ only in display, with a space after the symbol', () => {
    expect(withComparator('60', '>')).toBe('> 60');
    expect(withComparator('5', '<=')).toBe('≤ 5');
    expect(withComparator('45', '>=')).toBe('≥ 45');
    expect(withComparator('5.2')).toBe('5.2');
  });
});

/** Which input each exported threshold constant grades, key by key; null for a derived value no limit reaches. */
const CONSTANT_FIELDS: Record<string, LimitField | null | Record<string, LimitField | null>> = {
  HBA1C_THRESHOLDS: 'hba1c',
  LIPID_TREATMENT_TARGETS: { apobGl: 'apoB', ldlMmol: 'ldlC', nonHdlMmol: null },
  LDL_THRESHOLDS: 'ldlC',
  TOTAL_CHOLESTEROL_THRESHOLDS: 'totalCholesterol',
  NON_HDL_THRESHOLDS: null,
  HDL_THRESHOLDS: 'hdlC',
  HDL_GRID_BANDS: 'hdlC',
  CREATININE_GRID_BANDS: 'creatinine',
  TRIGLYCERIDES_THRESHOLDS: 'triglycerides',
  BP_THRESHOLDS: { elevatedSys: 'systolicBp', stage1Sys: 'systolicBp', stage2Sys: 'systolicBp', crisisSys: 'systolicBp', stage1Dia: 'diastolicBp', stage2Dia: 'diastolicBp', crisisDia: 'diastolicBp' },
  EGFR_THRESHOLDS: 'labEgfr',
  APOB_THRESHOLDS: 'apoB',
  APOB_RISK_ENHANCING: 'apoB',
  PSA_THRESHOLDS: 'psa',
  LPA_THRESHOLDS: 'lpa',
};

const leaves = (v: unknown, path = ''): Array<[string, number]> => typeof v === 'number' ? [[path, v]]
  : Object.entries(v as object).flatMap(([k, x]) => leaves(x, path ? `${path}.${k}` : k));

describe('US-12 AC20 — the cutoff set holds every threshold', () => {
  const exported = Object.keys(units).filter((name) => /_(THRESHOLDS|TARGETS|BANDS|RISK_ENHANCING)$/.test(name));

  it('maps every exported threshold constant, so a new one fails here until it joins', () => {
    expect(exported.sort()).toEqual(Object.keys(CONSTANT_FIELDS).sort());
  });

  it.each(Object.entries(CONSTANT_FIELDS))('%s: each value is in its input\'s cutoffs', (name, fields) => {
    for (const [path, value] of leaves((units as Record<string, unknown>)[name])) {
      const key = path.split('.')[0];
      const field = typeof fields === 'object' && fields !== null ? fields[key] : fields;
      if (field === null) continue;
      expect(field, `${name}.${path} has no input`).toBeDefined();
      expect(LIMIT_CUTOFFS[field!], `${name}.${path}`).toContain(value);
    }
  });

  it('holds both systolic targets (bpTargetFor)', () => {
    expect(LIMIT_CUTOFFS.systolicBp).toEqual(expect.arrayContaining([units.bpTargetFor(40), units.bpTargetFor(70)]));
  });

  /** An identifier naming a graded input, as the grading code spells it. */
  const NAMES: Record<string, LimitField> = {
    hba1c: 'hba1c', ldlC: 'ldlC', totalCholesterol: 'totalCholesterol', hdlC: 'hdlC', triglycerides: 'triglycerides',
    apoB: 'apoB', creatinine: 'creatinine', psa: 'psa', lpa: 'lpa', systolicBp: 'systolicBp', sys: 'systolicBp',
    diastolicBp: 'diastolicBp', dia: 'diastolicBp', eGFR: 'labEgfr', egfr: 'labEgfr', labEgfr: 'labEgfr',
  };
  const FILES = ['suggestions.ts', 'medication-cascades.ts', 'calculations.ts', 'stat-tiles.ts', 'units.ts', 'evidence.ts',
    '../../../widget-src/src/lib/blood-test-cell.ts'];

  it.each(FILES)('%s compares a graded input with no literal outside its cutoffs', (file) => {
    const code = readFileSync(join(here, file), 'utf8').replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '');
    const name = Object.keys(NAMES).join('|');
    const pattern = new RegExp(String.raw`\b(${name})\b\s*(?:<=|>=|<|>)\s*(\d+(?:\.\d+)?)\b|\b(\d+(?:\.\d+)?)\s*(?:<=|>=|<|>)\s*(?:[\w.]*\.)?(${name})\b`, 'g');
    const found = [...code.matchAll(pattern)].map((m) => [NAMES[m[1] ?? m[4]], Number(m[2] ?? m[3])] as const);
    for (const [field, literal] of found) expect(LIMIT_CUTOFFS[field], `${file}: ${field} against ${literal}`).toContain(literal);
  });
});

describe('US-12 AC20 — only when the bound decides', () => {
  it('decides by the four rules, strict and non-strict, at a cutoff', () => {
    const { prediabetes, diabetes } = units.HBA1C_THRESHOLDS;
    expect(limitDecides('hba1c', '<', prediabetes)).toBe(true); // every cutoff at or above b
    expect(limitDecides('hba1c', '<=', prediabetes)).toBe(false); // the cutoff itself is in the band
    expect(limitDecides('hba1c', '>', diabetes)).toBe(true);
    expect(limitDecides('hba1c', '>=', diabetes)).toBe(false);
    expect(limitDecides('hba1c', '<', prediabetes + 0.1)).toBe(false);
  });

  it('eGFR "> 90" decides: every eGFR cutoff is at or below 90', () => {
    expect(limitRepresentative('labEgfr', '>', 90)).toBeGreaterThan(90);
  });

  it('eGFR "> 60" does not decide: the eGFR tile grades 70 and over "Normal", 60-69 "Low Normal"', () => {
    expect(LIMIT_CUTOFFS.labEgfr).toContain(70);
    expect(limitRepresentative('labEgfr', '>', 60)).toBeNull();
  });

  it.each([
    ['lpa', '<', 10], ['psa', '<', 0.01], ['hdlC', '>', 1.5],
  ] as const)('%s %s %s decides', (field, comparator, bound) => {
    const value = limitRepresentative(field, comparator, bound)!;
    expect(value).not.toBeNull();
    expect(comparator === '<' ? value < bound : value > bound).toBe(true);
    expect(field in sanitizeInputs({ [field]: value })).toBe(true);
  });

  it('LDL "< 1.5" does not decide: the 1.4 target lies below', () => {
    expect(limitRepresentative('ldlC', '<', 1.5)).toBeNull();
  });

  it('no representative outside the schema: "< 9" HbA1c has no value below the 9 floor', () => {
    expect(limitRepresentative('hba1c', '<', 9)).toBeNull();
    expect(limitRepresentative('lpa', '>', 750)).toBeNull();
  });
});

describe('US-12 AC20 — an input read from a row', () => {
  it('a deciding limit holds the representative and says it is graded', () => {
    const inputs = withRowValue<Partial<HealthInputs>>({ heightCm: 170 }, 'lpa', 10, '<');
    expect(inputs.lpa).toBeLessThan(10);
    expect(inputs.limits).toEqual({ lpa: { comparator: '<', bound: 10, graded: true } });
  });

  it('an undecided limit holds nothing, and is still named as a limit', () => {
    const inputs = withRowValue<Partial<HealthInputs>>({ heightCm: 170, ldlC: 3 }, 'ldlC', 1.5, '<');
    expect('ldlC' in inputs).toBe(false);
    expect(inputs.limits).toEqual({ ldlC: { comparator: '<', bound: 1.5, graded: false } });
  });

  it('an exact value clears the field\'s limit', () => {
    const limited = withRowValue<Partial<HealthInputs>>({ heightCm: 170 }, 'ldlC', 1.5, '<');
    expect(withRowValue(limited, 'ldlC', 2.1)).toEqual({ heightCm: 170, ldlC: 2.1 });
  });
});

describe('US-12 AC20 — every conversion a limit passes through keeps its order', () => {
  it('every core unit converts with a positive slope (HbA1c NGSP to IFCC is affine, slope positive)', () => {
    for (const [metric, def] of Object.entries(units.UNIT_DEFS)) {
      for (const system of ['si', 'conventional'] as const) {
        const { min, max } = def.validationRange[system];
        const lo = def.toCanonical[system](min + (max - min) * 0.25);
        const hi = def.toCanonical[system](min + (max - min) * 0.75);
        expect(hi, `${metric} ${system}`).toBeGreaterThan(lo);
      }
    }
  });

  it('every printed unit spelling a core metric takes converts with a positive slope', () => {
    const spellings = ['umol/l', 'micromol/l', 'lb', 'mmol/mol', '%', 'ug/l', 'mg/dl', 'mg/l', 'mmhg'];
    for (const metric of Object.keys(units.UNIT_DEFS) as units.MetricType[]) {
      for (const unit of spellings) {
        const a = units.reportedToCanonical(metric, 2, unit);
        const b = units.reportedToCanonical(metric, 3, unit);
        if (a && b) expect(b.valueSI, `${metric} ${unit}`).toBeGreaterThan(a.valueSI);
      }
    }
  });

  it('every lab catalogue factor is positive', () => {
    for (const entry of LAB_CATALOG) {
      const factors = [...Object.values(entry.conversions ?? {}), ...(entry.nameConversions ?? []).flatMap((n) => Object.values(n.conversions))];
      for (const factor of factors) expect(factor, entry.key).toBeGreaterThan(0);
    }
  });
});
