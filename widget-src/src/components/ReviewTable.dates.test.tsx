// @vitest-environment jsdom
/**
 * US-12 AC12 — a previous-results column that prints its own date becomes
 * that date's values: its own column in the review, saved as ordinary dated
 * rows, one per (metric, day). Synthetic two-date table.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import type { ApiMeasurement } from '@roadmap/health-core';
import { ReviewTable, buildMatrixModel, type FileResult } from './ReviewTable';

afterEach(cleanup);

const PRIMARY = '2026-03-10';
const PREVIOUS = '2025-09-02';

const twoDates: FileResult[] = [{
  fileName: 'labs.pdf',
  reportDate: PRIMARY,
  values: [
    { metric: 'ldl', valueSI: 2.6, displayValue: 2.6, displayUnit: 'mmol/L', confidence: 'high' },
    { metric: 'ldl', valueSI: 3.1, displayValue: 3.1, displayUnit: 'mmol/L', confidence: 'high', recordedAt: PREVIOUS },
  ],
  additionalValues: [
    { name: 'sodium', value: 140, unit: 'mmol/L' },
    { name: 'sodium', value: 138, unit: 'mmol/L', recordedAt: PREVIOUS },
  ],
}];

const held = (value: number): ApiMeasurement[] => [
  { id: 'held-ldl', metricType: 'ldl', value, recordedAt: `${PREVIOUS}T00:00:00.000Z`, createdAt: `${PREVIOUS}T00:00:00.000Z` },
];

function renderReview(measurements: ApiMeasurement[] = []) {
  const onSave = vi.fn();
  const utils = render(
    <ReviewTable grading={{}} results={twoDates} history={{ measurements, labValues: [], documents: [] }}
      unitSystem="si" onSave={onSave} onCancel={() => {}} isSaving={false} error={null} />,
  );
  const save = () => fireEvent.click(utils.container.querySelector<HTMLButtonElement>('.review-save-btn')!);
  return { ...utils, onSave, save };
}

describe('US-12 AC12: a dated previous column is its own date in the review', () => {
  it('builds one column per printed date, each value editable in its own', () => {
    const { columns, cells } = buildMatrixModel(twoDates, { 0: { day: '10', month: '03', year: '2026' } }, [], [], 'si');
    expect(columns.map(c => [c.dateKey, c.isNew])).toEqual([[PREVIOUS, true], [PRIMARY, true]]);
    expect(cells.get(`ldl|${PREVIOUS}`)).toMatchObject({ state: 'editable', valueSI: 3.1 });
    expect(cells.get(`ldl|${PRIMARY}`)).toMatchObject({ state: 'editable', valueSI: 2.6 });
    expect(cells.get(`lab:sodium|${PREVIOUS}`)).toMatchObject({ state: 'editable', valueSI: 138 });
    expect(cells.get(`lab:sodium|${PRIMARY}`)).toMatchObject({ state: 'editable', valueSI: 140 });
  });

  it('a primary-column reading beats another file\'s previous-column read of the same (metric, day), whichever file comes first', () => {
    const sameDay: FileResult[] = [
      ...twoDates,
      { fileName: 'older.pdf', reportDate: PREVIOUS, additionalValues: [],
        values: [{ metric: 'ldl', valueSI: 3.0, displayValue: 3.0, displayUnit: 'mmol/L', confidence: 'high' }] },
    ];
    const dateOf = (iso: string) => { const [year, month, day] = iso.split('-'); return { year, month, day }; };
    for (const results of [sameDay, [...sameDay].reverse()]) {
      const dates = Object.fromEntries(results.map((r, i) => [i, dateOf(r.reportDate!)]));
      const { cells } = buildMatrixModel(results, dates, [], [], 'si');
      expect(cells.get(`ldl|${PREVIOUS}`)).toMatchObject({ state: 'editable', valueSI: 3.0 });
    }
  });

  it('saves each value as an ordinary row on its own day', () => {
    const { onSave, save } = renderReview();
    save();
    const { values, labValues } = onSave.mock.calls[0][0];
    expect(values).toEqual([
      expect.objectContaining({ metric: 'ldl', valueSI: 2.6, recordedAt: `${PRIMARY}T00:00:00.000Z` }),
      expect.objectContaining({ metric: 'ldl', valueSI: 3.1, recordedAt: `${PREVIOUS}T00:00:00.000Z` }),
    ]);
    expect(labValues).toEqual([
      expect.objectContaining({ name: 'sodium', value: 140, recordedAt: `${PRIMARY}T00:00:00.000Z` }),
      expect.objectContaining({ name: 'sodium', value: 138, recordedAt: `${PREVIOUS}T00:00:00.000Z` }),
    ]);
  });

  it('a previous value the record already holds is context, not a second row (dedup on metric and day)', () => {
    const { onSave, save } = renderReview(held(3.1));
    save();
    expect(onSave.mock.calls[0][0].values).toEqual([
      expect.objectContaining({ metric: 'ldl', valueSI: 2.6, recordedAt: `${PRIMARY}T00:00:00.000Z` }),
    ]);
  });

  it('a differing held value on the previous day is a conflict, Replace unticked', () => {
    const { container, onSave, save } = renderReview(held(3.4));
    expect(container.querySelectorAll('.bt-cell-conflict')).toHaveLength(1);
    save();
    expect(onSave.mock.calls[0][0].values.map((v: { valueSI: number }) => v.valueSI)).toEqual([2.6]);
  });

  it('editing the report date moves only the primary column; the printed previous day stays', () => {
    const { container, onSave, save } = renderReview();
    const headers = container.querySelectorAll<HTMLInputElement>('input[aria-label="Choose column date"]');
    expect(headers).toHaveLength(2);
    fireEvent.change(headers[1], { target: { value: '2026-03-11' } });
    save();
    expect(onSave.mock.calls[0][0].values.map((v: { valueSI: number; recordedAt: string }) => [v.valueSI, v.recordedAt])).toEqual([
      [2.6, '2026-03-11T00:00:00.000Z'], [3.1, `${PREVIOUS}T00:00:00.000Z`],
    ]);
  });
});
