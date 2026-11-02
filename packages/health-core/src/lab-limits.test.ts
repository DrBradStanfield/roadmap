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
  LIMIT_CUTOFFS, LIMIT_LABEL_CUTOFFS, limitLabelValue, limitNumber, bandDecides, limitRepresentative, readPrintedLimit, withComparator, withRowValue, type LimitField,
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

  it('a bound in another unit rounds away from its band, and keeps every place it needs', () => {
    expect(limitNumber(60 / 38.67, 1, '>')).toBe('1.55'); // 1.55159…: rounded down, still true
    expect(limitNumber(60 / 38.67, 1, '<')).toBe('1.56');
    expect(limitNumber(0.01, 1, '<')).toBe('0.01');
    expect(limitNumber(60, 0, '>')).toBe('60');
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

/** Every line anything compares an input against: the plan's grading lines and the label lines. */
const ALL_LINES = (field: LimitField) => [...LIMIT_CUTOFFS[field], ...LIMIT_LABEL_CUTOFFS[field]];

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
      expect(ALL_LINES(field!), `${name}.${path}`).toContain(value);
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
  /** The plan's own files: what they compare an input against must be a grading line (adversary R7). */
  const PLAN_FILES = ['suggestions.ts', 'medication-cascades.ts', 'calculations.ts', 'evidence.ts', 'plan.ts', 'reminders.ts', 'reminder-schedule.ts'];
  /** The tiles and grids: their comparisons must be label lines. */
  const LABEL_FILES = ['stat-tiles.ts', '../../../widget-src/src/lib/blood-test-cell.ts'];
  const STATUS_FUNCTIONS = /export function get\w+Status\([^)]*\)[^{]*\{[\s\S]*?\n\}/g;
  const source = (file: string) => readFileSync(join(here, file), 'utf8').replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '');
  /** calculations.ts's `get…Status` functions are the tiles' status words: label code, not the plan's. */
  const planCode = (file: string) => source(file).replace(STATUS_FUNCTIONS, '');
  const statusCode = () => (source('calculations.ts').match(STATUS_FUNCTIONS) ?? []).join('\n');

  /** Each comparison of a graded input with a numeric literal, as [input, literal]. */
  const literals = (code: string) => {
    const name = Object.keys(NAMES).join('|');
    const pattern = new RegExp(String.raw`\b(${name})\b\s*(?:<=|>=|<|>)\s*(\d+(?:\.\d+)?)\b|\b(\d+(?:\.\d+)?)\s*(?:<=|>=|<|>)\s*(?:[\w.]*\.)?(${name})\b`, 'g');
    return [...code.matchAll(pattern)].map((m) => [NAMES[m[1] ?? m[4]], Number(m[2] ?? m[3]), m[0]] as const);
  };
  /** Each threshold constant member the code reads, as [input, value, text]; a derived input's are skipped. */
  const constants = (code: string) => {
    const pattern = new RegExp(String.raw`\b(${Object.keys(CONSTANT_FIELDS).join('|')})\b(?:\.(\w+))?`, 'g');
    return [...code.matchAll(pattern)].flatMap(([text, name, member]) => {
      const constant = (units as Record<string, unknown>)[name];
      const fields = CONSTANT_FIELDS[name];
      const field = typeof fields === 'object' && fields !== null ? fields[member ?? ''] : fields;
      const value = typeof constant === 'number' ? constant : member ? (constant as Record<string, unknown>)[member] : undefined;
      return field && typeof value === 'number' ? [[field, value, text] as const] : [];
    });
  };

  /** Each scan, its lines, and the fewest comparisons it must find (so an empty match fails). */
  const SCANS: Array<[string, () => string, (field: LimitField) => readonly number[], number]> = [
    ['plan files', () => PLAN_FILES.map(planCode).join('\n'), (field) => LIMIT_CUTOFFS[field], 40],
    ['calculations.ts get…Status', statusCode, (field) => LIMIT_LABEL_CUTOFFS[field], 8],
    ['tiles and grids', () => LABEL_FILES.map(source).join('\n'), (field) => LIMIT_LABEL_CUTOFFS[field], 10],
  ];

  it.each(SCANS)('%s compare a graded input only against their own lines', (_name, code, lines, minimum) => {
    const found = [...literals(code()), ...constants(code())];
    expect(found.length).toBeGreaterThanOrEqual(minimum);
    for (const [field, value, text] of found) expect(lines(field), `${text} (${field} ${value})`).toContain(value);
  });
});

describe('US-12 AC20 — only when the bound decides', () => {
  it('decides by the four rules, strict and non-strict, at a cutoff', () => {
    const { prediabetes, diabetes } = units.HBA1C_THRESHOLDS;
    expect(bandDecides(LIMIT_CUTOFFS.hba1c, '<', prediabetes)).toBe(true); // every cutoff at or above b
    expect(bandDecides(LIMIT_CUTOFFS.hba1c, '<=', prediabetes)).toBe(false); // the cutoff itself is in the band
    expect(bandDecides(LIMIT_CUTOFFS.hba1c, '>', diabetes)).toBe(true);
    expect(bandDecides(LIMIT_CUTOFFS.hba1c, '>=', diabetes)).toBe(false);
    expect(bandDecides(LIMIT_CUTOFFS.hba1c, '<', prediabetes + 0.1)).toBe(false);
  });

  it('eGFR "> 90" decides for the plan and for the tile', () => {
    expect(limitRepresentative('labEgfr', '>', 90)).toBeGreaterThan(90);
    expect(limitLabelValue('labEgfr', '>', 90)).toBeGreaterThan(90);
  });

  // The orchestrator, 2026-11-02 (option B): the 70 line drives only the tile's word.
  it('eGFR "> 60" decides for the plan (its one line is 45), not for the tile word (70 is a label line)', () => {
    expect(LIMIT_CUTOFFS.labEgfr).toEqual([45]);
    expect(LIMIT_LABEL_CUTOFFS.labEgfr).toContain(70);
    expect(limitRepresentative('labEgfr', '>', 60)).toBeGreaterThan(60);
    expect(limitLabelValue('labEgfr', '>', 60)).toBeNull();
  });

  it('grid colour bands are label lines only: a creatinine limit is graded by the plan, coloured only when it clears the bands', () => {
    expect(LIMIT_CUTOFFS.creatinine).toEqual([]);
    expect(limitLabelValue('creatinine', '<', 50)).not.toBeNull();
    expect(limitLabelValue('creatinine', '<', 100)).toBeNull();
    expect(limitRepresentative('creatinine', '<', 100)).not.toBeNull();
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

// Adversary review of 0a2b89b0 (R8).
describe('US-12 AC20: a reference bound of exactly 0 is no cutoff; a negative one is', () => {
  it('CRP "< 1" with a printed range of 0-5 decides', async () => {
    const { referenceGradeValue } = await import('./lab-limits');
    expect(referenceGradeValue({ comparator: '<', bound: 1 }, 0, 5)).not.toBeNull();
    expect(referenceGradeValue({ comparator: '<', bound: 6 }, 0, 5)).toBeNull();
  });
  it('base excess with a range of -2 to 2: "< 1" does not decide (-2 lies below), "> 3" does', async () => {
    const { referenceGradeValue } = await import('./lab-limits');
    expect(referenceGradeValue({ comparator: '<', bound: 1 }, -2, 2)).toBeNull();
    expect(referenceGradeValue({ comparator: '>', bound: 3 }, -2, 2)).not.toBeNull();
  });
});
