// @vitest-environment jsdom
/**
 * US-13 AC10: the review's accessibility text never stores a value. Session
 * replay and error tools capture aria-label, title and alt, so those name
 * tests only. A screen reader still hears the values: the Replace box and a
 * lab input are described (aria-describedby) by the visible text that shows
 * them. Synthetic values; test names without digits, so any digit is a value.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import type { ApiMeasurement } from '@roadmap/health-core';
import type { ApiLabValue } from '../lib/api-types';
import { ReviewTable, type FileResult } from './ReviewTable';

afterEach(cleanup);

const DAY = '2026-03-10';
const at = `${DAY}T00:00:00.000Z`;
const core = (metric: string, valueSI: number) =>
  ({ metric, valueSI, displayValue: valueSI, displayUnit: 'mmol/L', confidence: 'high' as const });
const heldCore = (id: string, metricType: string, value: number): ApiMeasurement =>
  ({ id, metricType, value, recordedAt: at, createdAt: at });
const heldLab = (id: string, metricName: string, value: number, unit: string): ApiLabValue =>
  ({ id, metricName, value, unit, referenceLow: null, referenceHigh: null, recordedAt: at, source: 'manual', createdAt: at });

const results: FileResult[] = [{
  fileName: 'labs.pdf', reportDate: DAY,
  values: [core('hdl', 1.4), core('ldl', 2.8)],
  additionalValues: [
    { name: 'Iron', value: 100, unit: 'µg/dL' }, // converted on save, and in conflict with a held µmol/L row
    { name: 'Albumin', value: 4, unit: 'g/dL' }, // converted on save
    { name: 'Ferritin', value: 134, unit: 'mg' }, // a unit the record refuses
    { name: 'Sodium', value: 140, unit: 'mmol/L' }, // equal to the saved row: context
  ],
}];
const history = {
  measurements: [heldCore('held-hdl', 'hdl', 1.2), heldCore('held-ldl', 'ldl', 2.8)],
  labValues: [heldLab('held-iron', 'iron', 15, 'µmol/L'), heldLab('held-na', 'sodium', 140, 'mmol/L')],
  documents: [],
};

function renderReview() {
  return render(<ReviewTable grading={{}} results={results} history={history}
    unitSystem="si" onSave={vi.fn()} onCancel={() => {}} isSaving={false} error={null} />);
}

/** Every label-like attribute in the review, with its text. */
const labelText = (root: HTMLElement) =>
  [...root.querySelectorAll('[aria-label], [title], [alt], [aria-valuetext]')].flatMap(el =>
    ['aria-label', 'title', 'alt', 'aria-valuetext'].map(a => el.getAttribute(a)).filter((t): t is string => t !== null));

describe('US-13 AC10: no aria-label, title or alt holds a value', () => {
  it('conflicts, context, converted and refused units, edits and a validation error: no digit in any label', () => {
    const view = renderReview();
    // The fixture really has each case on screen.
    expect(view.container.querySelectorAll('.bt-cell-conflict')).toHaveLength(2);
    expect(view.container.querySelectorAll('.bt-cell-context').length).toBeGreaterThanOrEqual(2);
    expect(view.container.querySelectorAll('.bt-cell-si')).toHaveLength(2);
    expect(labelText(view.container)).not.toHaveLength(0);
    expect(labelText(view.container).filter(t => /\d/.test(t))).toEqual([]);

    const [hdl, albumin] = ['1.4', '4'].map(v =>
      [...view.container.querySelectorAll<HTMLInputElement>('.bt-cell-input input')].find(i => i.value === v)!);
    fireEvent.change(albumin, { target: { value: '5' } });
    fireEvent.change(hdl, { target: { value: '999' } }); // out of range: an inline error
    expect(view.container.querySelector('.bt-input-error-text')).not.toBeNull();
    expect(labelText(view.container).filter(t => /\d/.test(t))).toEqual([]);
  });
});

describe('US-13 AC10: a screen reader hears the values through the visible text', () => {
  it('the Replace box is named by the test and described by the saved value and the new one', () => {
    const view = renderReview();
    const hdl = view.getByRole('checkbox', { name: 'Replace the saved hdl value with the new one' });
    expect(view.getByRole('checkbox', { description: '1.2 1.4' })).toBe(hdl);
    fireEvent.change(view.getByDisplayValue('1.4'), { target: { value: '1.6' } });
    expect(view.getByRole('checkbox', { description: '1.2 1.6' })).toBe(hdl);
  });

  it('a lab saved in another unit: both units are shown and heard', () => {
    const view = renderReview();
    const iron = view.getByRole('checkbox', { name: 'Replace the saved Iron value with the new one' });
    expect(view.getByRole('checkbox', { description: '15 µmol/L 100 µg/dL' })).toBe(iron);
    const conflict = iron.closest('.bt-cell-conflict')!;
    expect(conflict.querySelector('.bt-cell-conflict-old')?.textContent).toBe('15 µmol/L');
    expect(conflict.querySelector('.bt-cell-unit')?.textContent).toBe('µg/dL');
    expect(view.getByRole('textbox', { name: 'Iron value', description: 'µg/dL → 17.9 µmol/L' })).toBeTruthy();
  });

  it('a lab input is named by its test and described by the value Save stores', () => {
    const view = renderReview();
    expect(view.getByRole('textbox', { name: 'Albumin value', description: '→ 40 g/L' })).toBeTruthy();
  });

  it('a validation error describes its input; it is not a title', () => {
    const view = renderReview();
    fireEvent.change(view.getByDisplayValue('1.4'), { target: { value: '999' } });
    const error = view.container.querySelector('.bt-input-error-text')!.textContent!;
    expect(view.getByRole('textbox', { description: error }).getAttribute('title')).toBeNull();
  });
});
