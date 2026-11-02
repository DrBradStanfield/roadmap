// US-07 AC10 (Brad 2026-11-02, "do the proper fix"): on a website or BYOK upload the
// name the report printed files each row whenever it resolves; the model's pick
// stands only when it does not.
import { describe, expect, it } from 'vitest';
import { parseUnifiedResult, toUnifiedResult, unifiedSystemPrompt, type DocumentPromptMode } from './lab-extraction';
import { canonicalLabRow, labSlotKey, resolveLabCatalogEntry } from './lab-catalog';

const extract = (rows: { values?: unknown[]; additionalValues?: unknown[] }, mode: DocumentPromptMode = 'full') =>
  toUnifiedResult(parseUnifiedResult({ classification: 'lab_report', reportDate: '2026-10-30', document: null, values: [], additionalValues: [], ...rows }), mode);

const lab = (name: string, printedName?: string, value = 450, unit = 'nmol/L') =>
  ({ name, value, unit, referenceLow: null, referenceHigh: null, ...(printedName === undefined ? null : { printedName }) });
const core = (metric: string, printedName?: string, value = 2.8, unit = 'mmol/L') =>
  ({ metric, value, unit, confidence: 'high', ...(printedName === undefined ? null : { printedName }) });

describe('US-07 AC10: the printed name decides the filing', () => {
  it.each([
    ['cortisol_random', 'Cortisol', 'cortisol_am'],
    ['cortisol_am', 'Cortisol, Random', 'cortisol_random'],
    ['cortisol_am', 'P.M. cortisol', 'cortisol_pm'],
    ['vitamin_d3_total', 'Vitamin-D', 'vitamin_d'],
  ])('model %s, printed "%s": filed under %s', (picked, printed, slot) => {
    const [row] = extract({ additionalValues: [lab(picked, printed)] }).additionalValues;
    expect(labSlotKey(row.name)).toBe(slot);
    expect(row.printedName).toBe(printed);
  });

  it('a printed name that resolves to nothing leaves the model\'s pick standing', () => {
    const [row] = extract({ additionalValues: [lab('cortisol_am', 'Cortisol level, 8 o\'clock draw')] }).additionalValues;
    expect(labSlotKey(row.name)).toBe('cortisol_am');
  });

  it('only a whole-name resolve overrides, never a substring', () => {
    const [row] = extract({ additionalValues: [lab('cortisol_pm', 'Cortisol level, evening draw')] }).additionalValues;
    expect(row.name).toBe('cortisol_pm');
  });

  it('a "core" row whose printed name is a catalogued urine test is filed as that lab row, never as creatinine', () => {
    const result = extract({ values: [core('creatinine', 'Urine Creatinine', 120, 'mg/dL')] });
    expect(result.values).toEqual([]);
    expect(result.additionalValues.map((r) => labSlotKey(r.name))).toEqual(['urine_creatinine']);
  });

  it('a core row printed as another core metric is re-filed as that metric', () => {
    const { values } = extract({ values: [core('total_cholesterol', 'LDL Cholesterol')] });
    expect(values.map((v) => [v.metric, v.printedName])).toEqual([['ldl', 'LDL Cholesterol']]);
  });

  it('a lab row printed as a core metric is promoted, as a core-named row always was', () => {
    const { values, additionalValues } = extract({ additionalValues: [lab('apolipoprotein_b_level', 'Apolipoprotein B', 0.9, 'g/L')] });
    expect(values.map((v) => v.metric)).toEqual(['apob']);
    expect(additionalValues).toEqual([]);
  });

  it('the printed name carries a conversion its own words decide: "BUN" in mg/dL', () => {
    const [row] = extract({ additionalValues: [lab('urea', 'BUN', 14, 'mg/dL')] }).additionalValues;
    expect(row.name).toBe('BUN');
  });

  it('a row without a printed name, or with an empty or non-text one, is filed exactly as before', () => {
    const rows = { values: [core('ldl')], additionalValues: [lab('cortisol_random')] };
    const before = extract(rows);
    for (const printedName of ['', '   ', 42, null]) {
      const withBlank = extract({ values: [{ ...core('ldl'), printedName }], additionalValues: [{ ...lab('cortisol_random'), printedName }] });
      expect(withBlank).toEqual(before);
    }
    expect(before.additionalValues[0].name).toBe('cortisol_random');
  });

  it('the connector\'s metadata prompt does not ask for it, and its rows are filed by the model\'s pick', () => {
    const [row] = extract({ additionalValues: [lab('cortisol_random', 'Cortisol')] }, 'metadata').additionalValues;
    expect(row.name).toBe('cortisol_random');
    expect(unifiedSystemPrompt('metadata')).not.toContain('printedName');
  });

  it('the website prompt asks for the printed name in one rule and shows it in the format', () => {
    const prompt = unifiedSystemPrompt('full');
    expect(prompt).toContain('12. Every row in "values" and "additionalValues" also has "printedName": the test name exactly as the report prints it.');
    expect(prompt).toContain('"printedName": "LDL Cholesterol"');
    expect(prompt).toContain('"printedName": "Sodium"');
  });

  it('a long printed name is cut, and line breaks fold to spaces', () => {
    const [row] = extract({ additionalValues: [lab('x_test', `Some\ntest ${'z'.repeat(300)}`)] }).additionalValues;
    expect(row.printedName!.length).toBeLessThanOrEqual(120);
    expect(row.printedName).toMatch(/^Some test z/);
  });
});

describe('US-07 AC10: creatinine (Brad 2026-11-02)', () => {
  it('a printed name that says urine keeps the row urine, even when the model picked serum creatinine', () => {
    const result = extract({ values: [core('creatinine', 'Creatinine, random urine', 110, 'mg/dL')] });
    expect(result.values).toEqual([]);
    expect(result.additionalValues.map((r) => r.name)).toEqual(['Creatinine, random urine']);
  });

  it('a lab row the model named as creatinine but printed as urine is kept as that urine row', () => {
    const [row] = extract({ additionalValues: [lab('creatinine', 'U-Creat (spot)', 110, 'mg/dL')] }).additionalValues;
    expect(row.name).toBe('U-Creat (spot)');
  });

  it('a row the model filed as urine is never moved into blood creatinine ("Creatinine" under a URINE heading)', () => {
    const result = extract({ additionalValues: [lab('urine_creatinine', 'Creatinine', 9.8, 'mmol/L')] });
    expect(result.values).toEqual([]);
    expect(result.additionalValues.map((r) => labSlotKey(r.name))).toEqual(['urine_creatinine']);
  });

  it('otherwise it is blood creatinine, with no review flag', () => {
    const { values } = extract({ values: [core('creatinine', 'Creatinine (serum)', 82, 'µmol/L')] });
    expect(values.map((v) => [v.metric, v.confidence, v.question])).toEqual([['creatinine', 'high', undefined]]);
  });

  it('the unit check still refuses a urine-only unit on a blood creatinine', () => {
    const result = extract({ values: [core('creatinine', 'Creatinine', 3.1, 'mg/mmol')] });
    expect(result.values).toEqual([]);
    expect(result.refusedValues?.map((r) => r.metric)).toEqual(['creatinine']);
  });

  it('a tab or line break between printed words is a space, so "Creatinine<TAB>Urine" still says urine (Codex R2)', () => {
    const result = extract({ values: [core('creatinine', 'Creatinine\tUrine', 4, 'mg/dL')] });
    expect(result.values).toEqual([]);
    expect(result.additionalValues.map((r) => r.name)).toEqual(['Creatinine Urine']);
  });

  it('a row the model listed among other tests but the report printed as serum creatinine is promoted (Codex R1, Brad: "sounds fine")', () => {
    const result = extract({ additionalValues: [lab('cystatin_c', 'Serum Creatinine', 82, 'µmol/L')] });
    expect(result.values.map((v) => [v.metric, v.valueSI, v.printedName])).toEqual([['creatinine', 82, 'Serum Creatinine']]);
    expect(result.additionalValues).toEqual([]);
  });

  it('...but its unit is checked as a core creatinine\'s: a ratio unit is refused, never saved', () => {
    const result = extract({ additionalValues: [lab('cystatin_c', 'Serum Creatinine', 3.1, 'mg/mmol')] });
    expect(result.values).toEqual([]);
    expect(result.additionalValues).toEqual([]);
    expect(result.refusedValues?.map((r) => r.metric)).toEqual(['creatinine']);
  });

  it('...and a creatinine picked only by the model\'s name is still never promoted', () => {
    const result = extract({ additionalValues: [lab('creatinine', 'Kreatinin-Wert', 82, 'µmol/L')] });
    expect(result.values).toEqual([]);
  });
});

describe('US-07 AC10 adversary fixes', () => {
  it.each([
    ['creatinine', 'mg/mmol'], ['creatinine', ''], ['creatinine', 'µg/L'],
  ])('a printed "Cr" never overrides: model %s in "%s" keeps its own creatinine checks (R2, US-12 AC15)', (model, unit) => {
    const result = extract({ additionalValues: [lab(model, 'Cr', 3.1, unit)] });
    expect(result.additionalValues).toEqual([]);
    expect(result.refusedValues?.map((r) => r.metric)).toEqual(['creatinine']);
  });

  it('a printed "Cr" leaves a chromium the model\'s own row (R2)', () => {
    const [row] = extract({ additionalValues: [lab('chromium', 'Cr', 0.3, 'µg/L')] }).additionalValues;
    expect(row.name).toBe('chromium');
  });

  it.each(['full', 'metadata'] as const)('%s: a core row with no printed name is filed exactly as before; a non-key metric is still dropped (R3)', (mode) => {
    const { values } = extract({ values: [core('LDL'), core('Serum Creatinine', undefined, 80, '')] }, mode);
    expect(values).toEqual([]);
  });

  it('a printed name never moves a row into a core slot the model filled that day (R4)', () => {
    const { values } = extract({ values: [core('ldl', 'Cholesterol', 2.8), core('total_cholesterol', 'Total Cholesterol', 5.2)] });
    expect(values.map((v) => [v.metric, v.displayValue])).toEqual([['ldl', 2.8], ['total_cholesterol', 5.2]]);
  });

  it('a printed "BUN" in mg/dL is stored converted, as its own words say (the caller sees mmol/L)', () => {
    const [row] = extract({ additionalValues: [lab('urea', 'BUN', 14, 'mg/dL')] }).additionalValues;
    const entry = resolveLabCatalogEntry(row.name)!;
    expect(canonicalLabRow(entry, { value: row.value, unit: row.unit })?.stored).toMatchObject({ unit: 'mmol/L' });
    expect(canonicalLabRow(entry, { value: row.value, unit: row.unit })?.stored.value).toBeCloseTo(5.0, 1);
  });
});

describe('US-07 AC10: specimen, every test (Brad 2026-11-02: "go with (a)")', () => {
  it.each([
    ['urine_sodium', 'Sodium', 80, 'mmol/L'],
    ['urine_glucose', 'Glucose', 2.8, 'mmol/L'],
    ['urine_protein', 'Protein', 0.15, 'g/L'],
    ['salivary_cortisol_morning', 'Cortisol - Morning', 15, 'nmol/L'],
    ['salivary_cortisol_night', 'Cortisol PM', 1.5, 'nmol/L'],
  ])('model %s, printed "%s": kept as the specimen, never the blood test', (model, printed, value, unit) => {
    const result = extract({ additionalValues: [lab(model, printed, value, unit)] });
    expect(result.values).toEqual([]);
    expect(result.additionalValues.map((r) => r.name)).toEqual([model]);
  });

  it('a printed name that says saliva or urine wins over a blood pick', () => {
    const rows = extract({ additionalValues: [lab('cortisol_pm', 'Cortisol (saliva), late night', 1.5), lab('sodium', 'Urine Sodium, spot', 80, 'mmol/L')] }).additionalValues;
    expect(rows.map((r) => r.name)).toEqual(['Cortisol (saliva), late night', 'Urine Sodium, spot']);
    expect(rows.map((r) => labSlotKey(r.name))).toEqual(['cortisol (saliva), late night', 'urine sodium, spot']);
  });
});

describe('US-07 AC10 Codex re-check fixes', () => {
  it.each(['cr', 'Cr'])('a row named "%s", printed "Cr", stays a lab row: a printed "Cr" never confirms creatinine (R1)', (name) => {
    const result = extract({ additionalValues: [lab(name, 'Cr', 0.3, 'µg/L')] });
    expect(result.values).toEqual([]);
    expect(result.additionalValues.map((r) => r.name)).toEqual([name]);
    expect(result.refusedValues).toBeUndefined();
  });

  it('a core slot vacated by a row that moved to the lab rows can be taken by a printed name (R2)', () => {
    const { values, additionalValues } = extract({ values: [core('hdl', 'Sodium', 140), core('ldl', 'HDL Cholesterol', 1.3)] });
    expect(values.map((v) => [v.metric, v.displayValue])).toEqual([['hdl', 1.3]]);
    expect(additionalValues.map((r) => r.name)).toEqual(['Sodium']);
  });

  it('the connector (metadata) ignores an unasked printed name: no serum promotion (R3)', () => {
    const result = extract({ additionalValues: [lab('creatinine', 'Serum Creatinine', 1.5, 'mmol/L')] }, 'metadata');
    expect(result.values).toEqual([]);
  });
});

