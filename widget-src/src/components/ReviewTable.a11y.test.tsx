// @vitest-environment jsdom
/**
 * US-13 AC10: the review's accessibility text never stores a value. Session
 * replay and error tools capture aria-label, title and alt, so those name
 * tests and dates only; the date, in words, tells columns apart. A screen
 * reader still hears the values through aria-describedby: a lab input from
 * its visible notes, the Replace box from the visible saved value and a
 * hidden line mirroring the new one (text, never the input itself).
 * Synthetic values. A test's own name may hold a digit (HbA1c); any other is a value.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import type { ApiMeasurement } from '@roadmap/health-core';
import type { ApiLabValue } from '../lib/api-types';
import { a11yTextWithDigits } from '../testing/a11y-text';
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

function renderReview(files: FileResult[] = results) {
  return render(<ReviewTable grading={{}} results={files} history={history}
    unitSystem="si" onSave={vi.fn()} onCancel={() => {}} isSaving={false} error={null} />);
}

const ON = 'from 10 Mar 2026';

describe('US-13 AC10: no aria-label, title or alt holds a value', () => {
  it('conflicts, context, converted and refused units, edits and a validation error: no number but a date in any label', () => {
    const view = renderReview();
    // The fixture really has each case on screen.
    expect(view.container.querySelectorAll('.bt-cell-conflict')).toHaveLength(2);
    expect(view.container.querySelectorAll('.bt-cell-context').length).toBeGreaterThanOrEqual(2);
    expect(view.container.querySelectorAll('.bt-cell-si')).toHaveLength(2);
    expect(view.getByRole('textbox', { name: `HDL Cholesterol value ${ON}` })).toBeTruthy(); // a date is allowed
    expect(a11yTextWithDigits(view.container)).toEqual([]);

    const [hdl, albumin] = ['1.4', '4'].map(v => view.getByDisplayValue(v));
    fireEvent.change(albumin, { target: { value: '5' } });
    fireEvent.change(hdl, { target: { value: '999' } }); // out of range: an inline error
    expect(view.container.querySelector('.bt-input-error-text')).not.toBeNull();
    expect(a11yTextWithDigits(view.container)).toEqual([]);
  });

  it('the scan still catches a value beside a date or a row\'s name, and a name the page does not show', () => {
    const root = document.createElement('div');
    root.innerHTML = '<div class="bt-name-label">Vitamin B12</div><input aria-label="Vitamin B12 value from 2 Sep 2025">'
      + '<span title="Sep 2025"></span><b aria-label="Vitamin B12 1.2 from 2 Sep 2025"></b><i aria-label="Vitamin B13 value"></i>';
    expect(a11yTextWithDigits(root)).toEqual(['Vitamin B12 1.2 from 2 Sep 2025', 'Vitamin B13 value']);
  });
});

describe('US-13 AC10: a screen reader hears the values through text', () => {
  /** Every element an aria-describedby names: text, never an input. */
  const describers = (el: HTMLElement) =>
    (el.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean).map(id => document.getElementById(id)!);

  it('the Replace box is named by the test and its date, and described by the saved value and the new one', () => {
    const view = renderReview();
    const hdl = view.getByRole('checkbox', { name: `Replace the saved HDL Cholesterol value ${ON}` });
    expect(view.getByRole('checkbox', { description: '1.2 new value 1.4' })).toBe(hdl);
    expect(describers(hdl).map(el => el.tagName)).toEqual(['SPAN', 'SPAN']);
    fireEvent.change(view.getByDisplayValue('1.4'), { target: { value: '1.6' } });
    expect(view.getByRole('checkbox', { description: '1.2 new value 1.6' })).toBe(hdl);
  });

  it('a lab saved in another unit: both units are shown and heard', () => {
    const view = renderReview();
    const iron = view.getByRole('checkbox', { name: `Replace the saved Iron value ${ON}` });
    expect(view.getByRole('checkbox', { description: '15 µmol/L new value 100 µg/dL' })).toBe(iron);
    expect(describers(iron).every(el => el.tagName === 'SPAN')).toBe(true);
    const conflict = iron.closest('.bt-cell-conflict')!;
    expect(conflict.querySelector('.bt-cell-conflict-old')?.textContent).toBe('15 µmol/L');
    expect(conflict.querySelector('.bt-cell-unit')?.textContent).toBe('µg/dL');
    expect(view.getByRole('textbox', { name: `Iron value ${ON}`, description: 'µg/dL → 17.9 µmol/L' })).toBeTruthy();
  });

  it('a lab input is named by its test and date, and described by the value Save stores', () => {
    const view = renderReview();
    expect(view.getByRole('textbox', { name: `Albumin value ${ON}`, description: '→ 40 g/L' })).toBeTruthy();
  });

  it('one test in three columns: each input names its own column, the undated one in words', () => {
    const view = renderReview([{
      fileName: 'labs.pdf', reportDate: DAY, additionalValues: [],
      values: [core('ldl', 3.1), { ...core('ldl', 3.0), recordedAt: '2025-09-02' }],
    }, {
      fileName: 'old.docx', reportDate: '2025-06-10', additionalValues: [], values: [{ ...core('ldl', 2.9), recordedAt: 'undated' }],
    }]);
    for (const name of ['from 10 Mar 2026', 'from 2 Sep 2025', 'from the undated previous results']) {
      expect(view.getByRole('textbox', { name: `LDL Cholesterol value ${name}` })).toBeTruthy();
    }
    expect(a11yTextWithDigits(view.container)).toEqual([]);
  });

  it('a report dated with a month only: its inputs name the month', () => {
    const view = renderReview([{ fileName: 'labs.pdf', reportDate: '2025-09', additionalValues: [], values: [core('ldl', 3.1)] }]);
    expect(view.getByRole('textbox', { name: 'LDL Cholesterol value from Sep 2025' })).toBeTruthy();
  });

  it('a test whose own name has a digit: the name is allowed, a value is not', () => {
    const view = renderReview([{
      fileName: 'labs.pdf', reportDate: DAY,
      values: [{ metric: 'hba1c', valueSI: 40, displayValue: 40, displayUnit: 'mmol/mol', confidence: 'high' }],
      additionalValues: [{ name: 'Vitamin B12', value: 450, unit: 'pg/mL' }],
    }]);
    expect(view.getByRole('textbox', { name: `HbA1c value ${ON}` })).toBeTruthy();
    expect(view.getByRole('textbox', { name: `Vitamin B12 value ${ON}` })).toBeTruthy();
    expect(a11yTextWithDigits(view.container)).toEqual([]);
  });

  it('a validation error describes its input; it is not a title', () => {
    const view = renderReview();
    fireEvent.change(view.getByDisplayValue('1.4'), { target: { value: '999' } });
    const error = view.container.querySelector('.bt-input-error-text')!.textContent!;
    expect(view.getByRole('textbox', { description: error }).getAttribute('title')).toBeNull();
  });
});
