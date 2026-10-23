// US-05 AC2: the unit a core value is shown and typed in, shared by the
// website's matrices and the iPhone app (US-25 AC20).
import { describe, expect, it } from 'vitest';
import { cellDecimalPlaces, cellFromSI, cellLabel, cellRange, cellText, cellToSI, isLpaUnit, recordLpaUnit } from './cell-unit';

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
