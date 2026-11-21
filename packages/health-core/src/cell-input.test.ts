/**
 * One typed number committed to the upload's choices (web list PR 1, owner rulings 2026-11-21; US-03 AC3, US-02 AC7):
 * a number equal to the one shown sends nothing, another number is an edit in SI, an emptied input unticks, and text
 * that is no number reverts (sends nothing). Synthetic values only.
 */
import { describe, expect, it } from 'vitest';
import { cellCommit } from './cell-input';

const ldlMgdl = { number: '120', current: 3.1, cell: { metric: 'ldl' as const, unit: 'conventional' as const } };
const lpa = { number: '75', current: 75, cell: { metric: 'lpa' as const, unit: 'nmol/L' as const } };
const ferritin = { number: '80', current: 80, cell: null };

describe('cellCommit', () => {
  it('a number equal to the shown one, in any spelling, sends nothing (the Lp(a) pin)', () => {
    expect(cellCommit('v0', '120', ldlMgdl)).toBeNull();
    expect(cellCommit('v0', '120.0', ldlMgdl)).toBeNull();
    expect(cellCommit('v0', '75', lpa)).toBeNull();
    expect(cellCommit('a0', '80,0', ferritin)).toBeNull();
  });

  it('another number is an edit, a core value in SI, a lab in its own unit', () => {
    const edit = cellCommit('v0', '100', ldlMgdl);
    expect(edit).toMatchObject({ edit: 'v0' });
    expect((edit as { value: number }).value).toBeCloseTo(100 / 38.67, 3);
    expect(cellCommit('a0', '95', ferritin)).toEqual({ edit: 'a0', value: 95 });
  });

  it('an emptied input unticks the value', () => {
    expect(cellCommit('v0', '', ldlMgdl)).toEqual({ tick: 'v0', on: false });
    expect(cellCommit('v0', '   ', ldlMgdl)).toEqual({ tick: 'v0', on: false });
  });

  it('text that is no number reverts: nothing is sent', () => {
    for (const text of ['abc', '-5', '1e3', '1,234', '< 5']) expect([text, cellCommit('v0', text, ldlMgdl)]).toEqual([text, null]);
  });
});
