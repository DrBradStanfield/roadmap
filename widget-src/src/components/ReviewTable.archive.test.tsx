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

function renderReview(documents: ApiDocument[]) {
  const onSave = vi.fn();
  const utils = render(
    <ReviewTable
      results={results}
      history={{ bloodTests, labValues: [], documents }}
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
      .toBe('Nothing new to save. Save will archive the original PDF behind the values already in your record.');
    fireEvent.click(button);
    expect(onSave).toHaveBeenCalledWith({ values: [], documents: [], labValues: [] });
  });

  it('keeps Save disabled when the same bytes are already archived (fileRef set)', () => {
    const { button, container } = renderReview([{ ...connectorRow, fileRef: 'Lab results/x.pdf' }]);
    expect(button.disabled).toBe(true);
    expect(container.querySelector('.review-summary')?.textContent).toContain('No items selected');
  });

  it('keeps Save disabled when the record holds no row for these bytes and nothing is selected', () => {
    expect(renderReview([]).button.disabled).toBe(true);
  });
});
