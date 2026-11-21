/**
 * A read value as the person reads it (`shownValue`, web list PR 1a): a core value in their unit, its limit sign kept; an
 * edit exact, as Save writes it; a lab as printed. And the shared upload's view carries it only when given units (the web),
 * so the iPhone's rows are as before. Synthetic values only.
 */
import { describe, expect, it } from 'vitest';
import { core, EMPTY, extra, NOW } from './import-review.test-helpers';
import { ENTER_A_NUMBER, NUMERIC_SYNTAX_GUIDANCE, shownValue, typedCommit, typedTextError } from './cell-input';
import { valueAt } from './import-review';
import type { UnifiedExtractionResult } from './lab-extraction';
import { NO_CHOICES } from './upload-choices';
import type { UploadState } from './upload-flow';
import { uploadReview } from './upload-review';
import { uploadView } from './upload-view';

const x = (over: Partial<UnifiedExtractionResult>): UnifiedExtractionResult => ({ classification: 'lab_report', reportDate: '2026-11-01', values: [], additionalValues: [], unrecognized: [], document: null, ...over });
const at = (ext: UnifiedExtractionResult, ref: string) => valueAt(ext, ref)!;

describe('shownValue: a read value in the person\'s unit', () => {
  it('a core value in their unit, with its label; Save writes the SI value', () => {
    const ldl = x({ values: [core({ valueSI: 3.1, displayValue: 3.1 })] });
    expect(shownValue(at(ldl, 'v0'), undefined, 'conventional')).toEqual({ text: '120', number: '120', unit: 'mg/dL', current: 3.1, cell: { metric: 'ldl', unit: 'conventional' } });
    expect(shownValue(at(ldl, 'v0'), undefined, 'si')).toMatchObject({ number: '3.1', unit: 'mmol/L', current: 3.1 });
  });

  it('a limit keeps its sign; an edit drops it and is what Save writes', () => {
    const limit = x({ values: [core({ valueSI: 0.6, displayValue: 0.6, comparator: '<' })] });
    expect(shownValue(at(limit, 'v0'), undefined, 'si')).toMatchObject({ text: '< 0.6', number: '0.6' });
    expect(shownValue(at(limit, 'v0'), 2.7, 'si')).toMatchObject({ text: '2.7', number: '2.7', current: 2.7 });
  });

  it('a lab as printed, in its own unit, whatever the person\'s', () => {
    const ferritin = x({ additionalValues: [extra({ value: 80 })] });
    expect(shownValue(at(ferritin, 'a0'), undefined, 'conventional')).toEqual({ text: '80', number: '80', unit: 'µg/L', current: 80, cell: null });
    expect(shownValue(at(ferritin, 'a0'), 95, 'si')).toMatchObject({ number: '95', current: 95 });
  });
});

describe('the upload view carries it only when given units', () => {
  const state = (platform: 'web' | 'phone'): UploadState => ({
    phase: 'open', platform, run: 1, started: NOW, firstRead: NOW,
    files: [{ id: 'f', name: 'f.pdf', bytes: 1, hash: 'h-f', pages: { count: 1, truncated: false }, status: { s: 'read', extraction: x({ values: [core({ valueSI: 3.1, displayValue: 3.1 })] }), choices: NO_CHOICES } }],
  });
  const rows = (platform: 'web' | 'phone', units?: () => 'conventional') => {
    const s = state(platform);
    return uploadView(s, EMPTY, NOW, uploadReview(s, EMPTY, NOW), false, units).sure?.rows ?? [];
  };

  it('the web\'s rows show the number in the person\'s unit; the iPhone\'s, given none, have no `shown`', () => {
    expect(rows('web', () => 'conventional')).toEqual([expect.objectContaining({ ref: 'v0', saves: true, shown: expect.objectContaining({ number: '120', unit: 'mg/dL' }) })]);
    expect(rows('phone')[0]).not.toHaveProperty('shown');
  });
});

describe('typed text in a row (web list PR 1b; US-13 AC5, AC12; US-02 AC4, AC7)', () => {
  const ldl = (valueSI: number) => valueAt({ values: [core({ valueSI, displayValue: valueSI })] }, 'v0')!;
  const ferritin = valueAt({ additionalValues: [extra({})] }, 'a0')!;

  it('held text reads the cells\' guidance, moved byte for byte', () => {
    expect(typedTextError('abc')).toBe(NUMERIC_SYNTAX_GUIDANCE);
    expect(typedTextError('3..5')).toBe(ENTER_A_NUMBER);
    expect(ENTER_A_NUMBER).toBe('Enter a number');
    expect(typedTextError('1,234')).toMatch(/1234/);
  });

  it('commits: held, the same, or an edit in SI; a unit that does not fit the value is refused', () => {
    expect(typedCommit('abc', ldl(3.1), undefined, 'si')).toEqual({ kind: 'hold' });
    expect(typedCommit('3.10', ldl(3.1), undefined, 'si')).toEqual({ kind: 'same' });
    expect(typedCommit('120', ldl(3.1), undefined, 'conventional')).toEqual({ kind: 'same' }); // 3.1 mmol/L shows "120"
    expect(typedCommit('121', ldl(3.1), undefined, 'conventional')).toMatchObject({ kind: 'edit' });
    expect(typedCommit('12.9', ldl(12.94), undefined, 'si')).toEqual({ kind: 'edit', value: 12.9 }); // AC5: a correction
    expect(typedCommit('3.12', ldl(3.1), 3.14, 'si')).toEqual({ kind: 'edit', value: 3.12 }); // finer than the step shown
    expect(typedCommit('90', ferritin, undefined, null)).toEqual({ kind: 'edit', value: 90 });
    expect(typedCommit('90', ferritin, undefined, 'si')).toBeNull();
    expect(typedCommit('3.1', ldl(3.1), undefined, null)).toBeNull();
  });

  // Web list PR 1d (US-13 AC5, AC26): the row's own text committed is no change; an edit shows as the person gave it.
  it('the row\'s shown text committed again is no change, a printed limit included', () => {
    const limit = valueAt({ values: [core({ valueSI: 0.6, displayValue: 0.6, comparator: '<' })] }, 'v0')!;
    expect(shownValue(limit, undefined, 'si').text).toBe('< 0.6');
    expect(typedCommit('< 0.6', limit, undefined, 'si')).toEqual({ kind: 'same' });
    expect(typedCommit(' < 0.6 ', limit, undefined, 'si')).toEqual({ kind: 'same' });
    expect(typedCommit('<0.5', limit, undefined, 'si')).toEqual({ kind: 'hold' }); // other text with a sign stays held
  });

  // The unit it was typed in is the fourth argument (`FileChoices.editUnits`, owner ruling on PR 1949).
  it('an edit shows at the precision the person gave in the unit they typed it in; retyping it is no change', () => {
    expect(shownValue(ldl(3.1), 4.25, 'si', 'si')).toMatchObject({ text: '4.25', number: '4.25', current: 4.25 });
    expect(typedCommit('4.25', ldl(3.1), 4.25, 'si', 'si')).toEqual({ kind: 'same' });
    expect(shownValue(ldl(3.1), 4.25, 'conventional', 'si')).toMatchObject({ text: '164', current: 4.25 }); // another unit: rounded
    expect(typedCommit('164', ldl(3.1), 4.25, 'conventional', 'si')).toEqual({ kind: 'same' });
    expect(shownValue(ldl(3.1), undefined, 'si')).toMatchObject({ text: '3.1', number: '3.1' }); // untouched: rounded as today
    expect(shownValue(ldl(12.94), undefined, 'si').text).toBe('12.9');
  });

  it('an edit typed in conventional units round-trips without drift', () => {
    const commit = typedCommit('116.3', ldl(3.1), undefined, 'conventional');
    expect(commit).toMatchObject({ kind: 'edit' });
    const value = (commit as { value: number }).value;
    expect(shownValue(ldl(3.1), value, 'conventional', 'conventional')).toMatchObject({ text: '116.3', number: '116.3', unit: 'mg/dL' });
    expect(typedCommit('116.3', ldl(3.1), value, 'conventional', 'conventional')).toEqual({ kind: 'same' });
    const lab = valueAt({ additionalValues: [extra({})] }, 'a0')!;
    expect(shownValue(lab, 80.25, 'si')).toMatchObject({ text: '80.25', number: '80.25' });
    expect(typedCommit('80.25', lab, 80.25, null)).toEqual({ kind: 'same' });
  });
});
