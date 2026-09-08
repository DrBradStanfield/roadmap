// @vitest-environment jsdom
/**
 * US-13 AC1 (widened 2026-09-04) / US-35 AC8 — a lab PDF the connector filed
 * metadata-only (contentHash set, no fileRef) is archived by the website on
 * the next upload of the same bytes. The review step shows every value as
 * already recorded, so nothing is selected — Save must still be offered, and
 * must say what it will do.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import type { ApiMeasurement } from '@roadmap/health-core';
import { ReviewTable, type FileResult } from './ReviewTable';
import type { ApiDocument } from '../lib/api-types';

afterEach(cleanup);

const HASH = 'sha256-abc';
const bloodTests: ApiMeasurement[] = [
  { id: 'old-ldl', metricType: 'ldl', value: 3.9, recordedAt: '2024-06-01T00:00:00.000Z', createdAt: '2024-06-01T00:00:00.000Z' },
];
const results: FileResult[] = [{
  fileName: 'labs.pdf',
  reportDate: '2024-06-01',
  values: [{ metric: 'ldl', valueSI: 3.9, displayValue: 3.9, displayUnit: 'mmol/L', confidence: 'high' }],
  additionalValues: [],
  file: new Blob(['bytes'], { type: 'application/pdf' }),
  contentHash: HASH,
}];
const connectorRow: ApiDocument = {
  id: 'imported', documentType: 'pathology_report', title: 'Blood test results', documentDate: '2024-06-01',
  contentMd: '', metadata: { importedVia: 'connector' }, sourceFileName: 'labs.pdf',
  createdAt: '2024-06-02T00:00:00.000Z', fileRef: null, contentHash: HASH,
};

const LETTER_HASH = 'sha256-letter';
const letterResults: FileResult[] = [{
  fileName: 'clinic-letter.pdf',
  reportDate: null,
  values: [],
  additionalValues: [],
  document: { classification: 'clinic_letter', title: 'Cardiology follow-up', documentDate: '2024-06-10', contentMarkdown: '# Letter', metadata: {} },
  file: new Blob(['letter bytes'], { type: 'application/pdf' }),
  contentHash: LETTER_HASH,
}];
const connectorLetter: ApiDocument = {
  id: 'imported-letter', documentType: 'clinic_letter', title: 'Cardiology follow-up', documentDate: '2024-06-10',
  contentMd: '', metadata: { importedVia: 'connector' }, sourceFileName: 'clinic-letter.pdf',
  createdAt: '2024-06-11T00:00:00.000Z', fileRef: null, contentHash: LETTER_HASH,
};

function renderReview(documents: ApiDocument[], files: FileResult[] = results, savedBloodTests: ApiMeasurement[] = bloodTests) {
  const onSave = vi.fn();
  const utils = render(
    <ReviewTable
      results={files}
      history={{ bloodTests: savedBloodTests, labValues: [], documents }}
      unitSystem="si"
      onSave={onSave}
      onCancel={() => {}}
      isSaving={false}
      error={null}
    />,
  );
  return { ...utils, onSave, button: utils.container.querySelector<HTMLButtonElement>('.review-save-btn')! };
}

describe('ReviewTable — archiving the original behind a connector row (US-13 AC1, US-35 AC8)', () => {
  it('offers Save with nothing selected when the bytes match a metadata-only row, and says so', () => {
    const { button, onSave, container } = renderReview([connectorRow]);
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe('Save 1 Original');
    expect(container.querySelector('.review-summary')?.textContent)
      .toBe('Save will archive the original PDF. No extracted values or documents are selected.');
    fireEvent.click(button);
    expect(onSave).toHaveBeenCalledWith({ values: [], documents: [], labValues: [] });
  });

  it('US-12 AC6: describes original-only saving without claiming cleared values are stored', () => {
    const { button, onSave, container } = renderReview([], results, []);
    const inputs = container.querySelectorAll<HTMLInputElement>('.bt-cell-review input');
    expect(inputs.length).toBeGreaterThan(0);
    for (const input of inputs) fireEvent.change(input, { target: { value: '' } });
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe('Save 1 Original');
    expect(container.querySelector('.review-summary')?.textContent)
      .toBe('Save will archive the original PDF. No extracted values or documents are selected.');
    expect(container.querySelector('.review-summary')?.textContent).not.toContain('already in your record');
    fireEvent.click(button);
    expect(onSave).toHaveBeenCalledWith({ values: [], documents: [], labValues: [] });
  });

  it('keeps Save disabled when the same bytes are already archived (fileRef set)', () => {
    const { button, container } = renderReview([{ ...connectorRow, fileRef: 'Lab results/x.pdf' }]);
    expect(button.disabled).toBe(true);
    expect(container.querySelector('.review-summary')?.textContent).toContain('No items selected');
  });

  it('US-12 AC6: offers an original-only retry after saved values become history context', () => {
    const { button, onSave } = renderReview([]);
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe('Save 1 Original');
    fireEvent.click(button);
    expect(onSave).toHaveBeenCalledWith({ values: [], documents: [], labValues: [] });
  });

  it('offers Save for a clinic letter the connector filed: name-deduped to an unselected row, yet still an original to archive', () => {
    const { button, onSave, container } = renderReview([connectorLetter], letterResults);
    expect(container.querySelector<HTMLInputElement>('.review-row-check input')!.checked).toBe(false);
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe('Save 1 Original');
    expect(container.querySelector('.review-summary')?.textContent)
      .toBe('Save will archive the original PDF. No extracted values or documents are selected.');
    fireEvent.click(button);
    expect(onSave).toHaveBeenCalledWith({ values: [], documents: [], labValues: [] });
  });

  it('does not double-count a connector letter the user re-selects: it saves as a document, not also an original', () => {
    const { button, container } = renderReview([connectorLetter], letterResults);
    fireEvent.click(container.querySelector<HTMLInputElement>('.review-row-check input')!);
    expect(button.textContent).toBe('Save 1 Document');
  });

  it('keeps Save disabled for a name-deduped letter whose bytes the record does not hold', () => {
    expect(renderReview([{ ...connectorLetter, contentHash: null }], letterResults).button.disabled).toBe(true);
  });
});
