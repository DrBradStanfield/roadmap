// @vitest-environment jsdom
/**
 * The review's documents and failed files, as health-core's view draws them (design PR 10; US-13
 * AC14, AC6, US-06 AC5, US-12 AC26): every letter is saved, listed behind one row in picked order
 * with its title, kind and date, each correctable before Save; a name the record already holds is
 * no reason to skip a letter (US-12 AC6b retired, ruling Q3); a file not read shows its reason.
 * Before this PR the cards sorted by kind, carried a keep tick and an "Already saved" badge, and an
 * errored file read "Could not read this file: ...". Synthetic documents only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { ReviewTable } from '../testing/review-harness';
import type { FileResult } from '../lib/upload-pipeline';
import type { ApiDocument } from '../lib/api-types';
import { showingAll } from '../testing/import-review';

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-15T12:00:00Z')); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

const doc = (classification: NonNullable<FileResult['document']>['classification'], title: string, documentDate: string | null,
  metadata: Record<string, unknown> = {}, contentMarkdown = `Synthetic ${title}`) =>
  ({ classification, title, documentDate, contentMarkdown, metadata });
const file = (fileName: string, over: Partial<FileResult> = {}): FileResult =>
  ({ fileName, reportDate: null, values: [], additionalValues: [], ...over });

const results: FileResult[] = [
  file('broken.pdf', { error: 'Synthetic failure' }),
  file('letter-old.pdf', { document: doc('clinic_letter', 'Old letter', '2024-03-01') }),
  file('scan.pdf', { document: doc('scan_result', 'Colonoscopy', '2024-06', { screeningType: 'colorectal' }, 'x'.repeat(301)) }),
  file('labs.pdf', { reportDate: '2024-05-02', values: [{ metric: 'ldl', valueSI: 3, displayValue: 3, displayUnit: 'mmol/L', confidence: 'high' }] }),
  file('letter-new.pdf', { document: doc('clinic_letter', 'New letter', '2024-09-01') }),
  file('misc.pdf', { document: doc('other', 'Misc', null) }),
];
const saved: ApiDocument = { id: 'held', documentType: 'clinic_letter', title: 'Old letter', documentDate: '2024-03-01', contentMd: 'old',
  metadata: {}, sourceFileName: 'letter-old.pdf', createdAt: '2024-03-02T00:00:00.000Z' };

function review(age: number | undefined = 60, files = results) {
  const onSave = vi.fn();
  const view = showingAll(render(<ReviewTable results={files} history={{ measurements: [], labValues: [], documents: [saved] }}
    unitSystem="si" age={age} sex="male" grading={{}} onSave={onSave} onCancel={() => {}} isSaving={false} error={null} />));
  const cards = () => [...view.container.querySelectorAll('.review-documents .review-document-card')];
  const cardOf = (title: string) => cards().find(c => c.querySelector<HTMLInputElement>('.review-title-input')?.value === title)!;
  const save = () => {
    fireEvent.click(view.container.querySelector<HTMLButtonElement>('.review-save-btn')!);
    return onSave.mock.lastCall![0];
  };
  return { ...view, cards, cardOf, save };
}

describe('the review\'s documents (US-13 AC14)', () => {
  it('lists every letter in picked order behind one row, each with its kind; a held name is no reason to skip one', () => {
    const view = review();
    expect(view.getByRole('button', { name: '4 letters and documents will be saved' }).getAttribute('aria-expanded')).toBe('true');
    expect(view.cards().map(c => [c.querySelector('.review-doc-type-badge')!.textContent, c.querySelector<HTMLInputElement>('.review-title-input')!.value]))
      .toEqual([['clinic letter', 'Old letter'], ['scan result', 'Colonoscopy'], ['clinic letter', 'New letter'], ['other document', 'Misc']]);
    expect(view.container.querySelector('.review-row-dup')).toBeNull();
    expect(view.container.querySelector('.review-row-check')).toBeNull();
  });

  it('names the files and the documents in the summary, and Save says what it writes', () => {
    const view = review();
    expect(view.container.querySelector('.review-summary')!.textContent).toBe('6 files: 1 scan result, 2 clinic letters, 1 other document, 1 lab report');
    expect(view.container.querySelector('.review-save-btn')!.textContent).toBe('Save 1 value and 4 documents');
  });

  it('saves every letter as reviewed (US-13 AC6), the screening update with it (US-06 AC5)', () => {
    const { documents } = review().save();
    expect(documents.map((d: { sourceFileName: string; documentDate: string | null; screeningUpdate?: unknown }) => [d.sourceFileName, d.documentDate, d.screeningUpdate]))
      .toEqual([['letter-old.pdf', '2024-03-01', undefined], ['scan.pdf', null, { key: 'colorectal_last_date', date: '2024-06' }], ['letter-new.pdf', '2024-09-01', undefined], ['misc.pdf', null, undefined]]);
  });

  it('US-52 AC13d: an edited title is saved; a cleared one falls back to the extracted title', () => {
    const view = review();
    const title = view.cardOf('New letter').querySelector<HTMLInputElement>('.review-title-input')!;
    fireEvent.change(title, { target: { value: 'Edited letter' } });
    let out = view.save();
    expect(out.documents.find((d: { sourceFileName: string }) => d.sourceFileName === 'letter-new.pdf').title).toBe('Edited letter');
    fireEvent.change(title, { target: { value: '' } });
    expect(title.placeholder).toBe('Document title');
    out = view.save();
    expect(out.documents.find((d: { sourceFileName: string }) => d.sourceFileName === 'letter-new.pdf').title).toBe('New letter');
  });

  it('US-06 AC5, US-13 AC6: offers no screening update to an ineligible age, and asks for the date first when there is none', () => {
    expect(review(30).container.querySelector('.review-screening-update')).toBeNull();
    cleanup();
    const undated = [file('scan.pdf', { document: doc('scan_result', 'Colonoscopy', null, { screeningType: 'colorectal' }) })];
    const view = review(60, undated);
    expect(view.container.querySelector('.review-screening-update')!.textContent).toBe('Update colorectal screening date (pick the document date first)');
  });
});

describe('a file not read (US-12 AC26)', () => {
  it('is named with its reason in its own section; Save is not blocked by it', () => {
    const view = review();
    const section = view.container.querySelector('.review-failed-files')!;
    expect(section.querySelector('h4')!.textContent).toBe('1 file not read');
    expect(section.textContent).toContain('broken.pdf');
    expect(section.querySelector('.review-file-error')!.textContent).toBe('Our server could not read it. Please try again.');
    expect(view.container.querySelector<HTMLButtonElement>('.review-save-btn')!.disabled).toBe(false);
  });
});
