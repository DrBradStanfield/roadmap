/**
 * A read value as the person reads it (`shownValue`, web list PR 1a): a core value in their unit, its limit sign kept; an
 * edit exact, as Save writes it; a lab as printed. And the shared upload's view carries it only when given units (the web),
 * so the iPhone's rows are as before. Synthetic values only.
 */
import { describe, expect, it } from 'vitest';
import { core, EMPTY, extra, NOW } from './import-review.test-helpers';
import { shownValue } from './cell-input';
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
