/**
 * The web list's screening box per letter (US-13 AC6; owner ruling on the mount note, 2026-11-22): `uploadListPage`
 * names it in the web review's own words (ReviewFileSections.tsx), ticked by default with a known age, disabled with no
 * date. The phone's page and `uploadView` gain nothing. Synthetic values only.
 */
import { describe, expect, it } from 'vitest';
import { EMPTY, NOW } from './import-review.test-helpers';
import type { UnifiedExtractionResult } from './lab-extraction';
import { NO_CHOICES, type DocumentFix } from './upload-choices';
import type { UploadState } from './upload-flow';
import { uploadListPage } from './upload-list-page';
import { uploadReview } from './upload-review';
import type { ScreeningPerson } from './upload-screening';
import { uploadView } from './upload-view';

const letter = (type: string | null, raw: string | null): UnifiedExtractionResult => ({
  classification: 'scan_result', reportDate: null, values: [], additionalValues: [], unrecognized: [],
  document: { classification: 'scan_result', title: 'Synthetic scan', documentDate: raw, contentMarkdown: 'Synthetic', metadata: type ? { screeningType: type } : {} },
});
const open = (platform: 'web' | 'phone', x: UnifiedExtractionResult, document: DocumentFix = {}): UploadState => ({
  phase: 'open', platform, run: 1, started: NOW, firstRead: NOW,
  files: [{ id: 'a', name: 'a.pdf', bytes: 1, hash: 'ha', pages: { count: 1, truncated: false }, status: { s: 'read', extraction: x, choices: { ...NO_CHOICES, document } } }],
});
const page = (s: UploadState, person?: ScreeningPerson) => uploadListPage(s, EMPTY, NOW, uploadReview(s, EMPTY, NOW), false, person);

describe('US-13 AC6: the screening box on the web list', () => {
  it('names the type and the date it writes, in the grid\'s words, ticked by default with a known age', () => {
    expect(page(open('web', letter('colorectal', '2026-10-20')), { age: 60 }).letters[0].screening)
      .toEqual({ lead: 'Update ', type: 'colorectal', tail: ' screening date to 20 Oct 2026', checked: true, disabled: false });
  });

  it('a month alone dates it; a removed date disables it, unticked, asking for the date first', () => {
    expect(page(open('web', letter('colorectal', '2026-06')), { age: 60 }).letters[0].screening?.tail).toBe(' screening date to Jun 2026');
    expect(page(open('web', letter('colorectal', '2026-06'), { date: null }), { age: 60 }).letters[0].screening)
      .toEqual({ lead: 'Update ', type: 'colorectal', tail: ' screening date (pick the document date first)', checked: false, disabled: true });
  });

  it('no age: shown unticked; the person\'s tick stands either way', () => {
    expect(page(open('web', letter('colorectal', '2026-10-20')), {}).letters[0].screening?.checked).toBe(false);
    expect(page(open('web', letter('colorectal', '2026-10-20'), { screening: true }), {}).letters[0].screening?.checked).toBe(true);
    expect(page(open('web', letter('colorectal', '2026-10-20'), { screening: false }), { age: 60 }).letters[0].screening?.checked).toBe(false);
  });

  it('none for an ineligible person, a letter with no screening type, the phone, or no person given', () => {
    expect(page(open('web', letter('breast', '2026-10-20')), { age: 60, sex: 'male' }).letters[0].screening).toBeUndefined();
    expect(page(open('web', letter('colorectal', '2026-10-20')), { age: 30 }).letters[0].screening).toBeUndefined();
    expect(page(open('web', letter(null, '2026-10-20')), { age: 60 }).letters[0].screening).toBeUndefined();
    // A screening box only for a type in the screening table.
    for (const type of ['knee', 'colorectal_method', 'endometrial']) expect(page(open('web', letter(type, '2026-10-20')), { age: 60 }).letters[0].screening, type).toBeUndefined();
    expect(page(open('phone', letter('colorectal', '2026-10-20')), { age: 60 }).letters[0].screening).toBeUndefined();
    expect(page(open('web', letter('colorectal', '2026-10-20'))).letters[0].screening).toBeUndefined();
  });

  it('uploadView, which the phone draws, is the same with or without a box', () => {
    const s = open('web', letter('colorectal', '2026-10-20'));
    const t = open('web', letter('colorectal', '2026-10-20'), { screening: false });
    expect(uploadView(t, EMPTY, NOW, uploadReview(t, EMPTY, NOW), false)).toEqual(uploadView(s, EMPTY, NOW, uploadReview(s, EMPTY, NOW), false));
  });
});
