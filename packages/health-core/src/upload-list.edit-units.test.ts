/**
 * The unit an edit was typed in (owner ruling on PR 1949, 2026-11-21; US-13 AC5, AC26): web only, beside the edit
 * (`FileChoices.editUnits`). In that unit the row shows the edit as typed; in any other, rounded to that unit's step, as a
 * value read is. Save's number never changes with the unit shown, and retyping the shown text in either unit is no change.
 * Synthetic values only.
 */
import { describe, expect, it } from 'vitest';
import { core, DAY, EMPTY, NOW } from './import-review.test-helpers';
import { valueAt } from './import-review';
import { cellNumber, cellToSI, type CellUnit } from './cell-unit';
import { shownValue } from './cell-input';
import type { UnifiedExtractionResult } from './lab-extraction';
import { choose, NO_CHOICES, type ChoiceChange, type FileChoices } from './upload-choices';
import { transition, type UploadState } from './upload-flow';
import { uploadList } from './upload-list';
import { uploadReview } from './upload-review';

const x: UnifiedExtractionResult = { classification: 'lab_report', reportDate: DAY, values: [core({ valueSI: 3.1, displayValue: 3.1 })], additionalValues: [], unrecognized: [], document: null };
const step = (c: FileChoices, change: ChoiceChange) => choose(c, change, NOW, x) ?? c;
const typed = (text: string, unit: CellUnit) => ({ typed: 'v0', text, unit });
const at = valueAt(x, 'v0')!;
type Open = Extract<UploadState, { phase: 'open' }>;
const open = (choices: FileChoices): Open => ({ phase: 'open', platform: 'web', run: 1, started: NOW, firstRead: NOW,
  files: [{ id: 'f0', name: 'f0.pdf', bytes: 1, hash: 'h-f0', pages: { count: 1, truncated: false }, status: { s: 'read', extraction: x, choices } }] });
const shownIn = (c: FileChoices, unit: CellUnit) => {
  const s = open(c);
  return uploadList(s, EMPTY, NOW, uploadReview(s, EMPTY, NOW), () => unit).rows[0].shown.text;
};

describe('an edit keeps the unit it was typed in (web only)', () => {
  it('"4.25" mmol/L shows "4.25"; in mg/dL the rounded display; back in mmol/L "4.25" again', () => {
    const c = step(NO_CHOICES, typed('4.25', 'si'));
    expect(c).toMatchObject({ edits: { v0: 4.25 }, editUnits: { v0: 'si' } });
    expect(shownIn(c, 'si')).toBe('4.25');
    expect(shownIn(c, 'conventional')).toBe(cellNumber('ldl', 4.25, 'conventional'));
    expect(shownIn(c, 'conventional')).toBe('164');
    expect(shownIn(c, 'si')).toBe('4.25');
  });

  it('typed in mg/dL: exact there, rounded in mmol/L', () => {
    const c = step(NO_CHOICES, typed('116.3', 'conventional'));
    expect(c.editUnits).toEqual({ v0: 'conventional' });
    expect(shownIn(c, 'conventional')).toBe('116.3');
    expect(shownIn(c, 'si')).toBe('3.0');
  });

  it('retyping the shown text in either unit is no change: the saved number is bit-identical', () => {
    const c = step(NO_CHOICES, typed('4.25', 'si'));
    const again = step(step(c, typed(shownIn(c, 'conventional'), 'conventional')), typed(shownIn(c, 'si'), 'si'));
    expect(Object.is(again.edits.v0, 4.25)).toBe(true);
    expect(again.editUnits).toEqual({ v0: 'si' });
  });

  it('the unit goes with the edit: a phone-style edit, or one cleared, drops it; a held text or a tick keeps it', () => {
    const c = step(NO_CHOICES, typed('4.25', 'si'));
    expect(step(c, { edit: 'v0', value: 4.4 })).not.toHaveProperty('editUnits');
    expect(step(c, { edit: 'v0', value: null })).not.toHaveProperty('editUnits');
    expect(step(c, typed('abc', 'si')).editUnits).toEqual({ v0: 'si' });
    expect(step(c, { tick: 'v0', on: false }).editUnits).toEqual({ v0: 'si' });
    expect(step(c, typed('120', 'conventional'))).toMatchObject({ edits: { v0: cellToSI('ldl', 120, 'conventional') }, editUnits: { v0: 'conventional' } });
  });

  it('shownValue without a typed unit rounds an edit as it rounds a value read', () => {
    expect(shownValue(at, 4.25, 'si').text).toBe('4.3');
    expect(shownValue(at, 4.25, 'si', 'si').text).toBe('4.25');
  });
});

/** mulberry32, as the other seeded properties here. */
function mulberry32(seed: number) {
  let a = seed;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/**
 * E1: any sequence of unit toggles and commits of the shown text leaves `edits[ref]` bit-identical, and the row shows the
 * edit as typed in its unit and rounded in the other. Mutations: `typedCommit` answering `same` only on the exact value
 * (its shown-text line gone, `sameAsSaved` replaced by `candidate === shown.current`) fails it on the first commit of a
 * rounded display ("typed 40.6 conventional, committing "1.0" in si moved 1.0499094905611586 to 1"); `shownValue` exact in
 * every unit (`editUnit !== unit` dropped) fails the table test above ("expected '164.3475' to be '164'").
 */
describe('E1: unit toggles and same-text commits never move an edit', () => {
  it('holds for 500 seeded sequences', () => {
    const units: CellUnit[] = ['si', 'conventional'];
    for (let seed = 1; seed <= 500; seed++) {
      const r = mulberry32(seed);
      const unit = units[Math.floor(r() * 2)];
      const text = unit === 'si' ? String((100 + Math.floor(r() * 900)) / 100) : String((400 + Math.floor(r() * 2500)) / 10);
      let c = step(NO_CHOICES, typed(text, unit));
      const saved = c.edits.v0;
      for (let i = 0; i < 6; i++) {
        const u = units[Math.floor(r() * 2)];
        const shown = shownIn(c, u);
        const want = u === unit ? text : cellNumber('ldl', saved, u);
        if (shown !== want) throw new Error(`seed ${seed}: typed ${text} ${unit}, shown ${shown} in ${u}, want ${want}`);
        c = step(c, typed(shown, u));
        if (!Object.is(c.edits.v0, saved)) throw new Error(`seed ${seed}: typed ${text} ${unit}, committing "${shown}" in ${u} moved ${saved} to ${c.edits.v0}`);
      }
    }
  });
});

describe('the machine keeps it (L7 also logs it in upload-view.property.test.ts)', () => {
  it('a typed commit through the machine sets it', () => {
    const s = transition(open(NO_CHOICES), { type: 'chose', id: 'f0', change: typed('4.25', 'si'), now: NOW }).state as Open;
    expect(s.files[0].status).toMatchObject({ choices: { editUnits: { v0: 'si' } } });
  });
});
