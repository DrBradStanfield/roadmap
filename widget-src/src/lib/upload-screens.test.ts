/**
 * Mount step 3a, US-13 AC6: the list's screens take the person of the form's plan basis, so a letter's screening box
 * shows for an eligible age and sex, ticked for a known age, as the grid's does; with no person, no box.
 */
import { describe, expect, it } from 'vitest';
import { createEmptyFile } from '@roadmap/health-core/roadmap-file';
import { NO_CHOICES } from '@roadmap/health-core/upload-choices';
import type { UploadState } from '@roadmap/health-core/upload-flow';
import { uploadReview } from '@roadmap/health-core/upload-review';
import { uploadScreens } from './upload-screens';

const NOW = '2026-11-22T00:00:00.000Z';
const s: UploadState = { phase: 'open', platform: 'web', run: 1, started: NOW, firstRead: NOW, files: [{
  id: 'f0', name: 'letter.pdf', bytes: 1, hash: 'hash-synthetic', pages: { count: 1, truncated: false }, status: { s: 'read', choices: NO_CHOICES, extraction: {
    classification: 'clinic_letter', reportDate: null, values: [], additionalValues: [], unrecognized: [],
    document: { classification: 'clinic_letter', title: 'Synthetic colonoscopy', documentDate: '2025-06-12', contentMarkdown: 'Synthetic', metadata: { screeningType: 'colorectal' } },
  } },
}] };
const page = (person?: { age?: number; sex?: 'male' | 'female' }) => uploadScreens({ uploadReview }, s,createEmptyFile({ deviceId: 'web', now: NOW }), NOW, false, () => 'si', person).page;

describe('US-13 AC6: the person reaches the list\'s page', () => {
  it.each([
    ['an eligible age and sex: the box, ticked', { age: 55, sex: 'female' as const }, { type: 'colorectal', checked: true, disabled: false }],
    ['no age: the box, unticked (eligibility unknown)', { sex: 'female' as const }, { type: 'colorectal', checked: false, disabled: false }],
    ['too young: no box', { age: 30, sex: 'female' as const }, undefined],
    ['no person: no box', undefined, undefined],
  ])('%s', (_case, person, box) => {
    const screening = page(person).letters[0].screening;
    expect(screening === undefined ? undefined : { type: screening.type, checked: screening.checked, disabled: screening.disabled }).toEqual(box);
  });
});
