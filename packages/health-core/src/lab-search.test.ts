// US-73 AC8: the iPhone's add sheet finds core and catalogue tests by name and alias as people type.
import { describe, expect, it } from 'vitest';
import { labSearch } from './lab-extraction';

const keys = (text: string) => labSearch(text).map((m) => m.key);

describe('labSearch (US-73 AC8)', () => {
  it('finds by the start of a name: "test" Testosterone, "hba" HbA1c, "ferr" Ferritin', () => {
    expect(labSearch('test')[0]).toMatchObject({ key: 'testosterone_total', name: 'Testosterone (total)' });
    expect(keys('hba')[0]).toBe('hba1c');
    expect(keys('ferr')).toEqual(['ferritin', 'transferrin', 'transferrin_sat', 'stfr']);
  });

  it('finds by alias, folded as the catalogue folds names, and puts the test the name resolves to first', () => {
    expect(keys('A1C')[0]).toBe('hba1c');
    expect(keys('sgpt')).toEqual(['alt']);
    expect(keys('LDL - Cholesterol')[0]).toBe('ldl');
    expect(keys('vitamin_d')[0]).toBe('vitamin_d');
    expect(keys('k')[0]).toBe('potassium');
  });

  it('finds a word inside a name, and a name inside', () => {
    expect(keys('bilirubin')).toEqual(expect.arrayContaining(['bilirubin_total', 'bilirubin_direct', 'bilirubin_indirect']));
    expect(keys('cholesterol')).toEqual(expect.arrayContaining(['total_cholesterol', 'ldl', 'hdl']));
  });

  it('says what each test is and the units it takes', () => {
    expect(labSearch('hba1c')[0]).toEqual({ name: 'HbA1c', key: 'hba1c', kind: 'core', unit: 'mmol/mol', units: ['mmol/mol', '%'] });
    expect(labSearch('lp(a)')[0]).toMatchObject({ key: 'lpa', kind: 'core', unit: 'nmol/L', units: ['nmol/L', 'mg/dL', 'mg/L'] });
    expect(labSearch('ferritin')[0]).toMatchObject({ name: 'Ferritin', key: 'ferritin', kind: 'catalogue', unit: 'µg/L' });
    expect(labSearch('ferritin')[0].units[0]).toBe('µg/L');
    expect(labSearch('ferritin')[0].units).toContain('ng/ml');
  });

  it('finds nothing for blank text or a name nothing knows, and at most the limit', () => {
    expect(labSearch('  ')).toEqual([]);
    expect(labSearch('zzqx')).toEqual([]);
    expect(labSearch('a', 5)).toHaveLength(5);
  });
});
