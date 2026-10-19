// @vitest-environment jsdom
/**
 * US-12 AC14 — a previous-results column with no printed date is its own
 * column in the review, with no date, and Save waits until the user picks its
 * day. It is never saved on the report date or this month. Synthetic
 * two-column table: a baseline sheet whose blood results sit only in "Prev.".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import type { ApiMeasurement } from '@roadmap/health-core';
import { ReviewTable, buildMatrixModel, type FileResult } from './ReviewTable';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-15T12:00:00Z')); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

const UNDATED = 'undated';

const sheet = (reportDate: string | null): FileResult[] => [{
  fileName: 'baseline.docx',
  reportDate,
  values: [
    { metric: 'ldl', valueSI: 2.6, displayValue: 2.6, displayUnit: 'mmol/L', confidence: 'high' },
    { metric: 'ldl', valueSI: 3.4, displayValue: 3.4, displayUnit: 'mmol/L', confidence: 'high', recordedAt: UNDATED },
    { metric: 'hdl', valueSI: 1.2, displayValue: 1.2, displayUnit: 'mmol/L', confidence: 'high', recordedAt: UNDATED },
  ],
  additionalValues: [
    { name: 'sodium', value: 139, unit: 'mmol/L', recordedAt: UNDATED },
  ],
}];

function renderReview(results: FileResult[], measurements: ApiMeasurement[] = []) {
  const onSave = vi.fn();
  const view = render(<ReviewTable grading={{}} results={results} history={{ measurements, labValues: [], documents: [] }}
    unitSystem="si" onSave={onSave} onCancel={() => {}} isSaving={false} error={null} />);
  const save = view.getByRole('button', { name: /^Save / }) as HTMLButtonElement;
  const previousPicker = () => view.getByLabelText('Choose the date of the previous results') as HTMLInputElement;
  return { view, onSave, save, previousPicker };
}

describe('US-12 AC14: an undated previous column waits for the user\'s date', () => {
  it('is its own column, first, keyed apart from the report\'s column and from any month', () => {
    for (const fileDate of [{ day: '10', month: '03', year: '2026' }, { day: null, month: '10', year: '2026' }]) {
      const { columns, cells } = buildMatrixModel(sheet(null), { 0: fileDate }, [], [], 'si');
      expect(columns.map(c => [c.dateKey, c.isNew, c.date.month])).toEqual([
        ['undated:0', true, ''],
        [fileDate.day ? '2026-03-10' : '2026-10', true, fileDate.month],
      ]);
      expect(cells.get('ldl|undated:0')).toMatchObject({ state: 'editable', valueSI: 3.4 });
      expect(cells.get('hdl|undated:0')).toMatchObject({ state: 'editable', valueSI: 1.2 });
      expect(cells.get('lab:sodium|undated:0')).toMatchObject({ state: 'editable', valueSI: 139 });
      expect(cells.get(`ldl|${columns[1].dateKey}`)).toMatchObject({ state: 'editable', valueSI: 2.6 });
    }
  });

  it('two files\' undated columns never merge', () => {
    const { columns } = buildMatrixModel([...sheet(null), ...sheet(null)], {}, [], [], 'si');
    expect(columns.filter(c => !c.date.month).map(c => c.dateKey)).toEqual(['undated:0', 'undated:1']);
  });

  it('shows no date, and Save stays disabled until its day is picked, even with a dated report', () => {
    const { view, onSave, save, previousPicker } = renderReview(sheet('2026-03-10'));
    expect(previousPicker().value).toBe('');
    expect(view.container.querySelector('.bt-header-row')?.textContent).toContain('Pick');
    expect(view.queryByRole('button', { name: /^Use / })).toBeNull();
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('saves its rows on the picked day; the report\'s column keeps the report date', () => {
    const { onSave, save, previousPicker } = renderReview(sheet('2026-03-10'));
    fireEvent.change(previousPicker(), { target: { value: '2025-09-02' } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    const { values, labValues } = onSave.mock.calls[0][0];
    expect(values.map((v: { metric: string; recordedAt: string }) => [v.metric, v.recordedAt]).sort()).toEqual([
      ['hdl', '2025-09-02T00:00:00.000Z'], ['ldl', '2025-09-02T00:00:00.000Z'], ['ldl', '2026-03-10T00:00:00.000Z'],
    ]);
    expect(labValues.map((v: { recordedAt: string }) => v.recordedAt)).toEqual(['2025-09-02T00:00:00.000Z']);
  });

  it('no dates anywhere (the customer\'s sheet): both columns need a day, and each saves on its own', () => {
    const { view, onSave, save, previousPicker } = renderReview(sheet(null));
    fireEvent.change(previousPicker(), { target: { value: '2025-09-02' } });
    expect(save.disabled).toBe(true);
    // The dated previous column now has a picker too; the report's is still empty.
    const reportPicker = view.getAllByLabelText('Choose column date').find(p => (p as HTMLInputElement).value === '')!;
    fireEvent.change(reportPicker, { target: { value: '2026-03-10' } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    const days = onSave.mock.calls[0][0].values.map((v: { metric: string; recordedAt: string }) => `${v.metric}@${v.recordedAt.slice(0, 10)}`);
    expect(days.sort()).toEqual(['hdl@2025-09-02', 'ldl@2025-09-02', 'ldl@2026-03-10']);
  });

  it('a future or impossible pick keeps Save disabled', () => {
    const { save, previousPicker } = renderReview(sheet('2026-03-10'));
    fireEvent.change(previousPicker(), { target: { value: '2027-01-05' } });
    expect(save.disabled).toBe(true);
  });

  it('picked on the report\'s own day, the primary reading still wins its slot', () => {
    const { onSave, save, previousPicker } = renderReview(sheet('2026-03-10'));
    fireEvent.change(previousPicker(), { target: { value: '2026-03-10' } });
    fireEvent.click(save);
    const values = onSave.mock.calls[0][0].values.map((v: { metric: string; valueSI: number }) => [v.metric, v.valueSI]);
    expect(values.sort()).toEqual([['hdl', 1.2], ['ldl', 2.6]]);
  });

  it('picked on a day the record holds, an equal value is context and a different one a conflict (US-13 AC3)', () => {
    const held: ApiMeasurement[] = [
      { id: 'held-ldl', metricType: 'ldl', value: 3.4, recordedAt: '2025-09-02T00:00:00.000Z', createdAt: '2025-09-02T00:00:00.000Z' },
      { id: 'held-hdl', metricType: 'hdl', value: 1.0, recordedAt: '2025-09-02T00:00:00.000Z', createdAt: '2025-09-02T00:00:00.000Z' },
    ];
    const dates = { 0: { day: '10', month: '03', year: '2026' }, '0@undated': { day: '02', month: '09', year: '2025' } };
    const { cells } = buildMatrixModel(sheet('2026-03-10'), dates, held, [], 'si');
    expect(cells.get('ldl|2025-09-02')).toMatchObject({ state: 'context', id: 'held-ldl' });
    expect(cells.get('hdl|2025-09-02')).toMatchObject({ state: 'editable', existing: { id: 'held-hdl' } });
  });
});
