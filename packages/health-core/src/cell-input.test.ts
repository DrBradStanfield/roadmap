/**
 * Text typed into a list row, committed by the engine (`choose` with `typed`; web list PR 1, owner ruling 2026-11-21 after
 * review; US-13 AC5, AC12; US-02 AC4, AC7): the shown number again changes nothing while the value is valid; another number
 * is an edit (a core value in SI); an emptied input unticks; text that is no number stays held in its row. Synthetic values only.
 */
import { describe, expect, it } from 'vitest';
import { core, extra, NOW } from './import-review.test-helpers';
import { ENTER_A_NUMBER, NUMERIC_SYNTAX_GUIDANCE, typedTextError } from './cell-input';
import { choose, NO_CHOICES, type FileChoices } from './upload-choices';
import type { UnifiedExtractionResult } from './lab-extraction';

const x = (over: Partial<UnifiedExtractionResult>): UnifiedExtractionResult => ({ classification: 'lab_report', reportDate: '2026-11-01', values: [], additionalValues: [], unrecognized: [], document: null, ...over });
const ldl = x({ values: [core({ valueSI: 3.1, displayValue: 3.1 })] });
const lpa = x({ values: [core({ metric: 'lpa', valueSI: 75, displayValue: 75, displayUnit: 'nmol/L' })] });
const ferritin = x({ additionalValues: [extra({ value: 80 })] });
const type = (ext: UnifiedExtractionResult, ref: string, text: string, unit: 'si' | 'conventional' | 'nmol/L' | null, c: FileChoices = NO_CHOICES) =>
  choose(c, { typed: ref, text, unit }, NOW, ext);

describe('typed text, committed by the engine', () => {
  it('the shown number again, in any spelling, changes nothing (the Lp(a) pin)', () => {
    expect(type(ldl, 'v0', '120', 'conventional')).toEqual(NO_CHOICES);
    expect(type(ldl, 'v0', '120.0', 'conventional')).toEqual(NO_CHOICES);
    expect(type(lpa, 'v0', '75', 'nmol/L')).toEqual(NO_CHOICES);
    expect(type(ferritin, 'a0', '80,0', null)).toEqual(NO_CHOICES);
  });

  it('Codex R2: an LDL of 12.94 mmol/L, out of range and shown as "12.9", retyped as "12.9" is corrected to 12.9 (US-13 AC5)', () => {
    const high = x({ values: [core({ valueSI: 12.94, displayValue: 12.94 })] });
    expect(type(high, 'v0', '12.9', 'si')).toMatchObject({ edits: { v0: 12.9 } });
    expect(type(ldl, 'v0', '3.1', 'si')).toEqual(NO_CHOICES); // a valid value's display keeps its exact value
  });

  it('another number is an edit, a core value in SI, a lab in its own unit; an out-of-range number is an edit too (AC5 blocks it)', () => {
    expect(type(ldl, 'v0', '100', 'conventional')?.edits.v0).toBeCloseTo(100 / 38.67, 3);
    expect(type(ferritin, 'a0', '95', null)).toMatchObject({ edits: { a0: 95 } });
    expect(type(ldl, 'v0', '50', 'si')).toMatchObject({ edits: { v0: 50 } });
  });

  it('an emptied input unticks the row', () => {
    expect(type(ldl, 'v0', '  ', 'si')).toMatchObject({ ticks: { v0: false } });
  });

  it('text that is no number is held in its row, with the cells\' own words, until a number, an emptied input or an untick replaces it', () => {
    for (const [text, why] of [['1,234', 'Did you mean 1234 or 1.234?'], ['-5', NUMERIC_SYNTAX_GUIDANCE], ['1e3', NUMERIC_SYNTAX_GUIDANCE], ['<5', NUMERIC_SYNTAX_GUIDANCE], ['1.2.3', ENTER_A_NUMBER]] as const) {
      const held = type(ldl, 'v0', text, 'si');
      expect([text, held?.typed]).toEqual([text, { v0: text }]);
      expect([text, typedTextError(text)]).toEqual([text, why]);
    }
    const held = type(ldl, 'v0', 'abc', 'si')!;
    expect(type(ldl, 'v0', '3.4', 'si', held)).toEqual({ ...NO_CHOICES, edits: { v0: 3.4 } });
    expect(type(ldl, 'v0', '3.1', 'si', held)).toEqual(NO_CHOICES);
    expect(type(ldl, 'v0', '', 'si', held)?.typed).toBeUndefined();
    expect(choose(held, { tick: 'v0', on: false }, NOW, ldl)?.typed).toBeUndefined();
  });

  it('a lab row with no range asks about "1,234" and refuses "1,234,567" (AC12)', () => {
    expect(type(ferritin, 'a0', '1,234', null)?.typed).toEqual({ a0: '1,234' });
    expect(typedTextError('1,234,567')).toBe('Type the number without commas.');
  });

  it('is refused for a unit that does not fit the value (a core value needs one, a lab takes none)', () => {
    expect(type(ldl, 'v0', '3.4', null)).toBeNull();
    expect(type(ferritin, 'a0', '95', 'si')).toBeNull();
  });
});
