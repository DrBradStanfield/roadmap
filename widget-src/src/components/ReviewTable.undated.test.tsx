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

/** The text input of a cell showing `value`. */
const cellInput = (view: ReturnType<typeof render>, value: string) =>
  Array.from(view.container.querySelectorAll<HTMLInputElement>('.bt-cell-input input')).find(i => i.value === value)!;

describe('US-12 AC14: an undated previous column waits for the user\'s date', () => {
  it('is its own column, first, keyed apart from the report\'s column and from any month', () => {
    for (const fileDate of [{ day: '10', month: '03', year: '2026' }, { day: null, month: '10', year: '2026' }]) {
      const { columns, cells } = buildMatrixModel(sheet(null), { 0: fileDate }, [], [], 'si');
      expect(columns.map(c => [c.dateKey, c.isNew, !!c.date.undated])).toEqual([
        ['undated:0', true, true],
        [fileDate.day ? '2026-03-10' : '2026-10', true, false],
      ]);
      expect(cells.get('ldl|undated:0')).toMatchObject({ state: 'editable', valueSI: 3.4 });
      expect(cells.get('hdl|undated:0')).toMatchObject({ state: 'editable', valueSI: 1.2 });
      expect(cells.get('lab:sodium|undated:0')).toMatchObject({ state: 'editable', valueSI: 139 });
      expect(cells.get(`ldl|${columns[1].dateKey}`)).toMatchObject({ state: 'editable', valueSI: 2.6 });
    }
  });

  it('two files\' undated columns never merge', () => {
    const { columns } = buildMatrixModel([...sheet(null), ...sheet(null)], {}, [], [], 'si');
    expect(columns.filter(c => c.date.undated).map(c => c.dateKey)).toEqual(['undated:0', 'undated:1']);
  });

  it('shows no date, and Save stays disabled until its day is picked, even with a dated report', () => {
    const { view, onSave, save, previousPicker } = renderReview(sheet('2026-03-10'));
    expect(previousPicker().value).toBe('');
    expect(view.container.querySelector('.bt-header-row')?.textContent).toContain('Pick a day');
    expect(view.container.querySelector('.bt-header-row')?.textContent).not.toContain('NaN');
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

  it('a month-only previous column names its printed month, and still needs a day', () => {
    const results = sheet('2026-03-10');
    results[0].values = results[0].values.map(v => (v.recordedAt ? { ...v, printedMonth: '2024-06' } : v));
    const { view, save, previousPicker } = renderReview(results);
    expect(view.container.querySelector('.bt-header-row')?.textContent).toContain('Pick a day in Jun 2024');
    expect(previousPicker().value).toBe('');
    expect(save.disabled).toBe(true);
    fireEvent.change(previousPicker(), { target: { value: '2024-06-01' } });
    expect(save.disabled).toBe(false);
  });

  // A stray "today" (an iOS picker dismissed) must not date the previous column.
  it('its day must come before the report\'s day: the same day or later keeps Save disabled', () => {
    for (const day of ['2026-03-10', '2026-03-11', '2026-10-15']) {
      const { save, previousPicker } = renderReview(sheet('2026-03-10'));
      fireEvent.change(previousPicker(), { target: { value: day } });
      expect(save.disabled, day).toBe(true);
      cleanup();
    }
  });

  it('with no report date yet, a later report pick before the previous day disables Save again', () => {
    const { view, save, previousPicker } = renderReview(sheet(null));
    fireEvent.change(previousPicker(), { target: { value: '2025-09-02' } });
    const reportPicker = view.getAllByLabelText('Choose column date').find(p => (p as HTMLInputElement).value === '')!;
    fireEvent.change(reportPicker, { target: { value: '2025-08-01' } });
    expect(save.disabled).toBe(true);
  });

  it('a column whose cells are all cleared needs no date: the dated report saves without it', () => {
    const { view, onSave, save } = renderReview(sheet('2026-03-10'));
    for (const value of ['3.4', '1.2', '139']) fireEvent.change(cellInput(view, value), { target: { value: '' } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    const { values, labValues } = onSave.mock.calls[0][0];
    expect(values.map((v: { metric: string; recordedAt: string }) => [v.metric, v.recordedAt])).toEqual([['ldl', '2026-03-10T00:00:00.000Z']]);
    expect(labValues).toEqual([]);
  });

  it('an edit made before the pick survives it, and saves as edited', () => {
    const { view, onSave, save, previousPicker } = renderReview(sheet('2026-03-10'));
    fireEvent.change(cellInput(view, '1.2'), { target: { value: '1.5' } });
    fireEvent.change(previousPicker(), { target: { value: '2025-09-02' } });
    fireEvent.click(save);
    const hdl = onSave.mock.calls[0][0].values.find((v: { metric: string }) => v.metric === 'hdl');
    expect(hdl).toMatchObject({ valueSI: 1.5, recordedAt: '2025-09-02T00:00:00.000Z', source: 'lab_import_edited' });
  });

  it('a cell cleared before the pick stays cleared after it: nothing saves for it', () => {
    const { view, onSave, save, previousPicker } = renderReview(sheet('2026-03-10'));
    fireEvent.change(cellInput(view, '1.2'), { target: { value: '' } });
    fireEvent.change(previousPicker(), { target: { value: '2025-09-02' } });
    fireEvent.click(save);
    const metrics = onSave.mock.calls[0][0].values.map((v: { metric: string; recordedAt: string }) => `${v.metric}@${v.recordedAt.slice(0, 10)}`);
    expect(metrics.sort()).toEqual(['ldl@2025-09-02', 'ldl@2026-03-10']);
  });

  it('a ticked Replace never carries to a different saved row when the day moves', () => {
    const held = (id: string, day: string): ApiMeasurement => ({ id, metricType: 'hdl', value: 1.0, recordedAt: `${day}T00:00:00.000Z`, createdAt: `${day}T00:00:00.000Z` });
    const { view, onSave, save, previousPicker } = renderReview(sheet('2026-03-10'), [held('held-a', '2025-09-02'), held('held-b', '2025-08-01')]);
    fireEvent.change(previousPicker(), { target: { value: '2025-09-02' } });
    fireEvent.click(view.getByRole('checkbox', { name: /Replace the saved hdl value/ }));
    fireEvent.change(previousPicker(), { target: { value: '2025-08-01' } });
    expect((view.getByRole('checkbox', { name: /Replace the saved hdl value/ }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(save);
    expect(onSave.mock.calls[0][0].values.find((v: { metric: string }) => v.metric === 'hdl')).toBeUndefined();
  });

  it('picked on a day the record holds, an equal value is context and a different one a conflict (US-13 AC3)', () => {
    const held: ApiMeasurement[] = [
      { id: 'held-ldl', metricType: 'ldl', value: 3.4, recordedAt: '2025-09-02T00:00:00.000Z', createdAt: '2025-09-02T00:00:00.000Z' },
      { id: 'held-hdl', metricType: 'hdl', value: 1.0, recordedAt: '2025-09-02T00:00:00.000Z', createdAt: '2025-09-02T00:00:00.000Z' },
    ];
    const dates = { 0: { day: '10', month: '03', year: '2026' }, '0@undated': { day: '02', month: '09', year: '2025' } };
    const { cells } = buildMatrixModel(sheet('2026-03-10'), dates, held, [], 'si');
    // Its own column still, compared against the saved rows on its picked day.
    expect(cells.get('ldl|2025-09-02')).toMatchObject({ state: 'context', id: 'held-ldl' });
    expect(cells.get('ldl|undated:0')).toBeUndefined();
    expect(cells.get('hdl|undated:0')).toMatchObject({ state: 'editable', existing: { id: 'held-hdl' } });
  });
});

/** The saved rows as metric=value@day, sorted. */
const savedRows = (onSave: ReturnType<typeof vi.fn>) =>
  onSave.mock.calls[0][0].values.map((v: { metric: string; valueSI: number; recordedAt: string }) => `${v.metric}=${v.valueSI}@${v.recordedAt.slice(0, 10)}`).sort();
const headerText = (view: ReturnType<typeof render>) => view.container.querySelector('.bt-header-row')?.textContent ?? '';

describe('US-12 AC14: an undated column never merges, and its day comes before its report\'s', () => {
  it('P1: a pick on or after the report\'s day is refused, not written, and the header names the limit; an earlier pick saves', () => {
    const { view, onSave, save, previousPicker } = renderReview(sheet('2026-03-10'));
    expect(headerText(view)).toContain('Pick a day before 10 Mar 2026');
    for (const day of ['2026-03-10', '2026-10-15']) {
      fireEvent.change(previousPicker(), { target: { value: day } });
      expect(previousPicker().value, day).toBe('');
      expect(headerText(view), day).toContain('Pick a day before 10 Mar 2026');
      expect(save.disabled, day).toBe(true);
    }
    fireEvent.change(previousPicker(), { target: { value: '2025-09-02' } });
    expect(previousPicker().value).toBe('2025-09-02');
    fireEvent.click(save);
    expect(savedRows(onSave)).toEqual(['hdl=1.2@2025-09-02', 'ldl=2.6@2026-03-10', 'ldl=3.4@2025-09-02']);
  });

  const other = (reportDate: string, values: FileResult['values']): FileResult => ({ fileName: 'other.pdf', reportDate, values, additionalValues: [] });
  const hba1c = { metric: 'hba1c', valueSI: 40, displayValue: 40, displayUnit: 'mmol/mol', confidence: 'high' as const };

  it('P2: picked on another file\'s report day it keeps its own column, and moving that file\'s date never moves it', () => {
    const { view, onSave, save, previousPicker } = renderReview([...sheet('2026-03-10'), other('2025-09-02', [hba1c])]);
    fireEvent.change(previousPicker(), { target: { value: '2025-09-02' } });
    expect(view.container.querySelectorAll('.bt-header-row .bt-strip-inner > :not(.bt-strip-spacer)')).toHaveLength(3);
    const otherPicker = view.getAllByLabelText('Choose column date').find(p => (p as HTMLInputElement).value === '2025-09-02')!;
    fireEvent.change(otherPicker, { target: { value: '2025-08-01' } });
    expect(previousPicker().value).toBe('2025-09-02');
    fireEvent.click(save);
    expect(savedRows(onSave)).toEqual(['hba1c=40@2025-08-01', 'hdl=1.2@2025-09-02', 'ldl=2.6@2026-03-10', 'ldl=3.4@2025-09-02']);
  });

  it('P2: on a day another file\'s report reads the same test, the report\'s reading wins the slot at save', () => {
    const hdl = { metric: 'hdl', valueSI: 1.1, displayValue: 1.1, displayUnit: 'mmol/L', confidence: 'high' as const };
    const { onSave, save, previousPicker } = renderReview([...sheet('2026-03-10'), other('2025-09-02', [hdl])]);
    fireEvent.change(previousPicker(), { target: { value: '2025-09-02' } });
    fireEvent.click(save);
    expect(savedRows(onSave)).toEqual(['hdl=1.1@2025-09-02', 'ldl=2.6@2026-03-10', 'ldl=3.4@2025-09-02']);
  });

  it('two files\' undated columns picked on one day save each (metric, day) once', () => {
    const { view, onSave, save } = renderReview([...sheet('2026-03-10'), ...sheet('2026-03-10')]);
    for (const picker of view.getAllByLabelText('Choose the date of the previous results')) fireEvent.change(picker, { target: { value: '2025-09-02' } });
    fireEvent.click(save);
    expect(savedRows(onSave)).toEqual(['hdl=1.2@2025-09-02', 'ldl=2.6@2026-03-10', 'ldl=3.4@2025-09-02']);
  });

  it('P7: no dates anywhere, both picked on one day: Save is blocked, the header names the limit, and either column can recover it', () => {
    for (const fix of ['previous', 'report'] as const) {
      const { view, onSave, save, previousPicker } = renderReview(sheet(null));
      const reportPicker = () => view.getByLabelText('Choose column date') as HTMLInputElement;
      fireEvent.change(previousPicker(), { target: { value: '2025-09-02' } });
      fireEvent.change(reportPicker(), { target: { value: '2025-09-02' } });
      expect(save.disabled, fix).toBe(true);
      expect(headerText(view), fix).toContain('Pick a day before 2 Sep 2025');
      if (fix === 'previous') fireEvent.change(previousPicker(), { target: { value: '2025-01-01' } });
      else fireEvent.change(reportPicker(), { target: { value: '2026-03-10' } });
      expect(save.disabled, fix).toBe(false);
      fireEvent.click(save);
      const previousDay = fix === 'previous' ? '2025-01-01' : '2025-09-02';
      const reportDay = fix === 'previous' ? '2025-09-02' : '2026-03-10';
      expect(savedRows(onSave), fix).toEqual([`hdl=1.2@${previousDay}`, `ldl=2.6@${reportDay}`, `ldl=3.4@${previousDay}`].sort());
      cleanup();
    }
  });

  it('P7: a report day picked before the previous one blocks Save until either moves', () => {
    const { view, save, previousPicker } = renderReview(sheet(null));
    fireEvent.change(previousPicker(), { target: { value: '2025-09-02' } });
    fireEvent.change(view.getByLabelText('Choose column date'), { target: { value: '2025-01-01' } });
    expect(save.disabled).toBe(true);
    fireEvent.change(previousPicker(), { target: { value: '2024-12-01' } });
    expect(save.disabled).toBe(false);
  });

  it('the limit is the file\'s report date even when that file has no report column of its own', () => {
    const only: FileResult[] = [{ fileName: 'only.docx', reportDate: '2019-01-05', additionalValues: [],
      values: [{ metric: 'hdl', valueSI: 1.2, displayValue: 1.2, displayUnit: 'mmol/L', confidence: 'high', recordedAt: UNDATED }] }];
    const { view, save, previousPicker } = renderReview(only);
    expect(headerText(view)).toContain('Pick a day before 5 Jan 2019');
    fireEvent.change(previousPicker(), { target: { value: '2025-09-02' } });
    expect(previousPicker().value).toBe('');
    expect(save.disabled).toBe(true);
    fireEvent.change(previousPicker(), { target: { value: '2018-06-01' } });
    expect(save.disabled).toBe(false);
  });

  const heldHdl = (value: number): ApiMeasurement[] => [{ id: 'held-hdl', metricType: 'hdl', value, recordedAt: '2025-09-02T00:00:00.000Z', createdAt: '2025-09-02T00:00:00.000Z' }];
  const replaceBox = (view: ReturnType<typeof render>) => view.queryByRole('checkbox', { name: /Replace the saved hdl value/ }) as HTMLInputElement | null;

  it('an edit is judged by its edited value: on a day holding the extracted value it is a conflict, Replace unticked, never hidden', () => {
    const { view, onSave, save, previousPicker } = renderReview(sheet('2026-03-10'), heldHdl(1.2));
    fireEvent.change(cellInput(view, '1.2'), { target: { value: '1.5' } });
    fireEvent.change(previousPicker(), { target: { value: '2025-09-02' } });
    expect(cellInput(view, '1.5')).toBeDefined();
    expect(replaceBox(view)?.checked).toBe(false);
    fireEvent.click(save);
    expect(onSave.mock.calls[0][0].values.find((v: { metric: string }) => v.metric === 'hdl')).toBeUndefined();
    fireEvent.click(replaceBox(view)!);
    fireEvent.click(save);
    expect(onSave.mock.calls[1][0].values.find((v: { metric: string }) => v.metric === 'hdl'))
      .toMatchObject({ valueSI: 1.5, recordedAt: '2025-09-02T00:00:00.000Z', source: 'lab_import_edited', correctsId: 'held-hdl' });
  });

  it('an edit equal to the saved row is context: no Replace, nothing saved for it', () => {
    const { view, onSave, save, previousPicker } = renderReview(sheet('2026-03-10'), heldHdl(1.0));
    fireEvent.change(cellInput(view, '1.2'), { target: { value: '1.0' } });
    fireEvent.change(previousPicker(), { target: { value: '2025-09-02' } });
    expect(replaceBox(view)).toBeNull();
    fireEvent.click(save);
    expect(onSave.mock.calls[0][0].values.find((v: { metric: string }) => v.metric === 'hdl')).toBeUndefined();
  });

  it('an edit made on a day holding the extracted value saves once the day moves on', () => {
    const { view, onSave, save, previousPicker } = renderReview(sheet('2026-03-10'), heldHdl(1.2));
    fireEvent.change(cellInput(view, '1.2'), { target: { value: '1.5' } });
    fireEvent.change(previousPicker(), { target: { value: '2025-09-02' } });
    fireEvent.change(previousPicker(), { target: { value: '2025-08-01' } });
    fireEvent.click(save);
    expect(onSave.mock.calls[0][0].values.find((v: { metric: string }) => v.metric === 'hdl'))
      .toMatchObject({ valueSI: 1.5, recordedAt: '2025-08-01T00:00:00.000Z', source: 'lab_import_edited' });
  });
});
