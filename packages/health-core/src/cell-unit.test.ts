// US-05 AC2: the unit a core value is shown and typed in, shared by the
// website's matrices and the iPhone app (US-25 AC20).
import { describe, expect, it } from 'vitest';
import { cellDecimalPlaces, cellFromSI, cellLabel, cellRange, cellText, cellToSI, isLpaUnit, labRangeMessage, recordLpaUnit } from './cell-unit';

describe('cell units (US-05 AC2)', () => {
  it('reads Lp(a)\'s saved unit, else the units\' default', () => {
    expect(isLpaUnit('mg/L')).toBe(true);
    expect(isLpaUnit('mmol/L')).toBe(false);
    expect(recordLpaUnit('mg/L', 'si')).toBe('mg/L');
    expect(recordLpaUnit(undefined, 'conventional')).toBe('mg/dL');
    expect(recordLpaUnit(42, 'si')).toBe('nmol/L');
    expect(recordLpaUnit(undefined, undefined)).toBe('nmol/L');
  });

  it('shows, reads and bounds Lp(a) in each of its units', () => {
    expect(['nmol/L', 'mg/dL', 'mg/L'].map((u) => cellText('lpa', 124, u as 'mg/L'))).toEqual(['124', '49.6', '496']);
    expect(cellToSI('lpa', 156, 'mg/dL')).toBeCloseTo(390, 9);
    expect(cellToSI('lpa', 93, 'mg/L')).toBeCloseTo(23.25, 9);
    expect(cellFromSI('lpa', 125, 'mg/L')).toBe(500);
    expect(cellDecimalPlaces('lpa', 'mg/dL')).toBe(1);
    expect(cellLabel('lpa', 'mg/L')).toBe('mg/L');
    expect(cellRange('lpa', 'mg/L')).toEqual({ min: 0, max: 3000 });
    expect(cellLabel('ldl', 'conventional')).toBe('mg/dL');
  });
});

// US-66 AC6 (US-73 AC8): a core value typed in a printed unit and refused, said in that unit.
describe('labRangeMessage (US-66 AC6)', () => {
  it('names Lp(a)\'s range in the one of its three units typed, never another of them', () => {
    expect(labRangeMessage('lpa', 'mg/L', 'above')).toBe('Max 3000 mg/L');
    expect(labRangeMessage('lpa', 'mg/dl', 'above')).toBe(`Max ${cellRange('lpa', 'mg/dL').max} mg/dL`);
    expect(labRangeMessage('lpa', 'nmol/L', 'above')).toBe(`Max ${cellRange('lpa', 'nmol/L').max} nmol/L`);
  });

  it('names any other metric\'s range in the system of the unit typed; null for a unit it does not take', () => {
    expect(labRangeMessage('ldl', 'mg/dL', 'above')).toMatch(/^Max \d+ mg\/dL$/);
    expect(labRangeMessage('ldl', 'mmol/L', 'below')).toMatch(/ mmol\/L$/);
    expect(labRangeMessage('ldl', 'furlongs', 'above')).toBeNull();
  });
});
