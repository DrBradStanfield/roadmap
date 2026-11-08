// @vitest-environment jsdom
/**
 * US-12 AC6b: a document named like one the record already holds starts
 * unticked ("Already saved"), and a tick the user gives it back holds until
 * Save. A history reload unticks it only when the record now holds a document
 * under that name that it did not hold before (one filed since: US-12 AC6),
 * never on a reload that filed nothing, such as a change from another device.
 * Synthetic documents only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { ReviewTable, type FileResult } from './ReviewTable';
import type { ApiDocument, UploadHistory } from '../lib/api-types';

afterEach(cleanup);

const result: FileResult = {
  fileName: 'report.pdf', reportDate: null, values: [], additionalValues: [],
  document: { classification: 'clinic_letter', title: 'Synthetic new letter', documentDate: '2024-06-01', contentMarkdown: 'Synthetic', metadata: {} },
};
const doc = (id: string): ApiDocument => ({
  id, documentType: 'clinic_letter', title: 'Synthetic old letter', documentDate: '2023-01-10', contentMd: 'old',
  metadata: {}, sourceFileName: 'report.pdf', createdAt: '2023-01-11T00:00:00.000Z',
});
const historyOf = (...documents: ApiDocument[]): UploadHistory => ({ measurements: [], labValues: [], documents });

function review(history: UploadHistory) {
  const onSave = vi.fn();
  const element = (h: UploadHistory) => (
    <ReviewTable results={[result]} history={h} unitSystem="si" grading={{}} onSave={onSave}
      onCancel={() => {}} isSaving={false} error={null} />
  );
  const view = render(element(history));
  const box = () => view.container.querySelector<HTMLInputElement>('.review-document-header input[type=checkbox]')!;
  const save = () => {
    fireEvent.click(view.getByRole('button', { name: /^Save / }));
    return onSave.mock.lastCall![0];
  };
  return { ...view, box, save, reload: (h: UploadHistory) => view.rerender(element(h)) };
}

describe('US-12 AC6b: a re-ticked "Already saved" document keeps its tick', () => {
  it('starts unticked when the record holds a document of that name, and the user can tick it', () => {
    const view = review(historyOf(doc('old-1')));
    expect(view.getByText('Already saved')).toBeTruthy();
    expect(view.box().checked).toBe(false);
    fireEvent.click(view.box());
    expect(view.box().checked).toBe(true);
  });

  it('keeps the tick through a reload that filed nothing (another device changed the record)', () => {
    const view = review(historyOf(doc('old-1')));
    fireEvent.click(view.box());
    view.reload(historyOf(doc('old-1')));
    expect(view.box().checked).toBe(true);
    expect(view.save().documents).toEqual([expect.objectContaining({ title: 'Synthetic new letter', sourceFileName: 'report.pdf' })]);
  });

  it('keeps the tick through a reload that filed another name', () => {
    const view = review(historyOf(doc('old-1')));
    fireEvent.click(view.box());
    view.reload(historyOf(doc('old-1'), { ...doc('other-1'), sourceFileName: 'other.pdf' }));
    expect(view.box().checked).toBe(true);
  });

  it('unticks it once the record holds a document of that name it did not hold before (US-12 AC6)', () => {
    const view = review(historyOf(doc('old-1')));
    fireEvent.click(view.box());
    view.reload(historyOf(doc('old-1'), doc('filed-now')));
    expect(view.box().checked).toBe(false);
    expect(view.queryByRole('button', { name: /^Save / })).toBeNull(); // nothing left to save
  });

  it('keeps a tick given back after that untick through the next reload that files nothing', () => {
    const view = review(historyOf(doc('old-1')));
    view.reload(historyOf(doc('old-1'), doc('filed-now')));
    expect(view.box().checked).toBe(false);
    fireEvent.click(view.box());
    view.reload(historyOf(doc('old-1'), doc('filed-now')));
    expect(view.box().checked).toBe(true);
  });

  it('unticks a new name the record has just filed (US-12 AC6)', () => {
    const view = review(historyOf());
    expect(view.box().checked).toBe(true);
    view.reload(historyOf(doc('filed-now')));
    expect(view.box().checked).toBe(false);
  });
});
