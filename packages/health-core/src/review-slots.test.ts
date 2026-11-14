// US-13 AC3, US-12 AC12/AC14/AC20: the review's slot precedence and sameness,
// shared by the import review's groups and the website's matrix.
import { describe, it, expect } from 'vitest';
import { placeReadings, readingRank, sameReading, type Quantity, type SlotReading } from './review-slots';
import { UNDATED_PREVIOUS } from './lab-extraction';

const at = (quantity: Quantity, rank: 0 | 1 | 2 = 0, more: Partial<SlotReading> = {}): SlotReading => ({ slot: 's', rank, quantity, sent: true, ...more });
const nothingHeld = () => undefined;

describe('sameReading: exact against limits (US-12 AC20)', () => {
  it.each<[string, Quantity, Quantity, boolean]>([
    ['core: equal numbers', { valueSI: 3.1 }, { valueSI: 3.1 + 1e-12 }, true],
    ['core: exact against a limit', { valueSI: 0.1 }, { valueSI: 0.1, comparator: '<' }, false],
    ['core: identical limits', { valueSI: 0.1, comparator: '<' }, { valueSI: 0.1, comparator: '<' }, true],
    ['core: different comparators', { valueSI: 0.1, comparator: '<' }, { valueSI: 0.1, comparator: '<=' }, false],
    ['lab: one result in two spellings', { lab: { name: 'ferritin', value: 80, unit: 'µg/L' } }, { lab: { name: 'Ferritin', value: 80, unit: 'ng/mL' } }, true],
    ['lab: exact against a limit', { lab: { name: 'ferritin', value: 80, unit: 'µg/L' } }, { lab: { name: 'ferritin', value: 80, unit: 'µg/L', comparator: '>' } }, false],
    ['lab: identical limits', { lab: { name: 'ferritin', value: 80, unit: 'µg/L', comparator: '>' } }, { lab: { name: 'ferritin', value: 80, unit: 'µg/L', comparator: '>' } }, true],
    ['lab: different comparators', { lab: { name: 'ferritin', value: 80, unit: 'µg/L', comparator: '>' } }, { lab: { name: 'ferritin', value: 80, unit: 'µg/L', comparator: '>=' } }, false],
    ['a core value and a lab are never the same', { valueSI: 80 }, { lab: { name: 'ferritin', value: 80, unit: 'µg/L' } }, false],
  ])('%s', (_name, a, b, same) => {
    expect(sameReading(a, b)).toBe(same);
    expect(sameReading(b, a)).toBe(same);
  });
});

describe('placeReadings', () => {
  it('ranks a report\'s own reading, then a dated previous column, then an undated one', () => {
    expect([undefined, '2026-01-01', UNDATED_PREVIOUS].map((d) => readingRank(d, UNDATED_PREVIOUS))).toEqual([0, 1, 2]);
    expect(placeReadings([at({ valueSI: 1 }, 2), at({ valueSI: 2 }, 1), at({ valueSI: 3 }, 0)], nothingHeld)).toEqual(['hidden', 'hidden', 'free']);
  });
  it('breaks a tie of rank by input order; an equal loser is a duplicate', () => {
    expect(placeReadings([at({ valueSI: 1 }), at({ valueSI: 2 }), at({ valueSI: 1 })], nothingHeld)).toEqual(['free', 'hidden', 'duplicate']);
  });
  it('a winner equal to the record lets a differing reading of its rank through, as the conflict', () => {
    const held = () => ({ valueSI: 1 });
    expect(placeReadings([at({ valueSI: 1 }), at({ valueSI: 2 })], held)).toEqual(['saved', 'conflict']);
    expect(placeReadings([at({ valueSI: 1 }), at({ valueSI: 2 }, 1)], held)).toEqual(['saved', 'hidden']);
  });
  it('an edited reading is never saved or a duplicate', () => {
    expect(placeReadings([at({ valueSI: 1 }, 0, { edited: true })], () => ({ valueSI: 1 }))).toEqual(['conflict']);
    expect(placeReadings([at({ valueSI: 1 }), at({ valueSI: 1 }, 0, { edited: true })], nothingHeld)).toEqual(['free', 'hidden']);
  });
  it('an unsent reading claims nothing and is judged against the record alone', () => {
    expect(placeReadings([at({ valueSI: 1 }, 0, { sent: false }), at({ valueSI: 2 })], nothingHeld)).toEqual(['free', 'free']);
  });
});
