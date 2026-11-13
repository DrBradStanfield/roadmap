// @vitest-environment jsdom
/**
 * Characterisation pins for ReviewTable's per-document review, taken before
 * it moved to useReviewDocuments + ReviewFileSections: the per-file sections'
 * DOM and order (US-12, errored files last), the error and "No blood test
 * values or document found" rows, the document Save payload byte for byte
 * (US-13 AC6 document dates, US-06 AC5 screening), title edits, and the
 * summary's document count. Synthetic documents only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { ReviewTable } from './ReviewTable';
import type { FileResult } from '../lib/upload-pipeline';
import type { ApiDocument } from '../lib/api-types';

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-15T12:00:00Z')); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

const doc = (classification: NonNullable<FileResult['document']>['classification'], title: string, documentDate: string | null,
  metadata: Record<string, unknown> = {}, contentMarkdown = `Synthetic ${title}`) =>
  ({ classification, title, documentDate, contentMarkdown, metadata });
const file = (fileName: string, over: Partial<FileResult> = {}): FileResult =>
  ({ fileName, reportDate: null, values: [], additionalValues: [], ...over });

// Deliberately out of render order.
const results: FileResult[] = [
  file('broken.pdf', { error: 'Synthetic failure' }),
  file('letter-old.pdf', { document: doc('clinic_letter', 'Old letter', '2024-03-01') }),
  file('scan.pdf', { document: doc('scan_result', 'Colonoscopy', '2024-06', { screeningType: 'colorectal' }, 'x'.repeat(301)) }),
  file('labs.pdf', { reportDate: '2024-05-02', values: [{ metric: 'ldl', valueSI: 3, displayValue: 3, displayUnit: 'mmol/L', confidence: 'high' }] }),
  file('blank.pdf'),
  file('letter-new.pdf', { document: doc('clinic_letter', 'New letter', '2024-09-01') }),
  file('misc.pdf', { document: doc('other', 'Misc', null) }),
];
const saved: ApiDocument = { id: 'held', documentType: 'clinic_letter', title: 'Old letter', documentDate: '2024-03-01', contentMd: 'old',
  metadata: {}, sourceFileName: 'letter-old.pdf', createdAt: '2024-03-02T00:00:00.000Z' };

function review(age: number | undefined = 60, files = results) {
  const onSave = vi.fn();
  const view = render(<ReviewTable results={files} history={{ measurements: [], labValues: [], documents: [saved] }}
    unitSystem="si" age={age} sex="male" grading={{}} onSave={onSave} onCancel={() => {}} isSaving={false} error={null} />);
  const sections = () => [...view.container.querySelectorAll('.review-file-section')];
  const sectionOf = (name: string) => sections().find(s => s.querySelector('.review-file-name')?.textContent === name)!;
  const save = () => {
    fireEvent.click(view.container.querySelector<HTMLButtonElement>('.review-save-btn')!);
    return onSave.mock.lastCall![0];
  };
  return { ...view, sections, sectionOf, save };
}

describe('per-document review pins', () => {
  it('US-12 AC9: orders the file sections: empty files, scans, letters newest first, other, errored last', () => {
    const view = review();
    expect(view.sections().map(s => s.querySelector('.review-file-name')!.textContent))
      .toEqual(['blank.pdf', 'scan.pdf', 'letter-new.pdf', 'letter-old.pdf', 'misc.pdf', 'broken.pdf']);
  });

  it('US-12 AC9: shows the error row and the nothing-found row', () => {
    const view = review();
    expect(view.sectionOf('broken.pdf').querySelector('.review-file-error')!.textContent).toBe('Could not read this file: Synthetic failure');
    expect(view.sectionOf('blank.pdf').querySelector('.review-no-values')!.textContent).toBe('No blood test values or document found in this file');
  });

  it('US-12 AC9: names the documents in the summary and on Save', () => {
    const view = review();
    expect(view.container.querySelector('.review-summary')!.textContent).toBe('1 value + 3 documents from 7 files · 1 extracted');
    expect(view.container.querySelector('.review-save-btn')!.textContent).toBe('Save 1 Value + 3 Documents');
  });

  it('US-13 AC6: hands up the same documents and reviewed results', () => {
    const { documents, reviewed } = review().save();
    expect(JSON.stringify({ documents, reviewed })).toMatchSnapshot();
  });

  it('US-52 AC13d: an edited title reaches documents and reviewed; a cleared one falls back to the extracted title', () => {
    const view = review();
    const title = view.sectionOf('letter-new.pdf').querySelector<HTMLInputElement>('.review-title-input')!;
    fireEvent.change(title, { target: { value: 'Edited letter' } });
    let out = view.save();
    expect(out.documents.find((d: { sourceFileName: string }) => d.sourceFileName === 'letter-new.pdf').title).toBe('Edited letter');
    expect(out.reviewed[5].document.title).toBe('Edited letter');
    fireEvent.change(title, { target: { value: '' } });
    expect(title.placeholder).toBe('Document title');
    out = view.save();
    expect(out.documents.find((d: { sourceFileName: string }) => d.sourceFileName === 'letter-new.pdf').title).toBe('New letter');
  });

  it('US-06 AC5, US-13 AC6: offers no screening update to an ineligible age, and asks for the date first when there is none', () => {
    expect(review(30).sectionOf('scan.pdf').querySelector('.review-screening-update')).toBeNull();
    const undated = [file('scan.pdf', { document: doc('scan_result', 'Colonoscopy', null, { screeningType: 'colorectal' }) })];
    const view = review(60, undated);
    expect(view.container.querySelector('.review-screening-update')!.textContent).toBe('Update colorectal screening date (pick the document date first)');
  });

  it('US-13 AC6: an unticked document saves nothing for it, yet stays in reviewed', () => {
    const view = review();
    fireEvent.click(view.sectionOf('misc.pdf').querySelector<HTMLInputElement>('.review-row-check input')!);
    const out = view.save();
    expect(out.documents.map((d: { sourceFileName: string }) => d.sourceFileName)).toEqual(['scan.pdf', 'letter-new.pdf']);
    expect(out.reviewed[6].document).toMatchObject({ title: 'Misc', documentDate: null });
  });
});
