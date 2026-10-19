// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { ReviewTable, type FileResult } from './ReviewTable';
import { cellToSI } from '../lib/blood-test-cell';

const record = vi.hoisted(() => ({ lpaUnit: undefined as string | undefined }));
vi.mock('../lib/roadmap-data', () => ({
  getLpaUnit: () => record.lpaUnit,
  setLpaUnit: (unit: string) => { record.lpaUnit = unit; },
}));
vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn() }));
afterEach(() => { cleanup(); localStorage.clear(); record.lpaUnit = undefined; });

const files: FileResult[] = [{
  fileName: 'synthetic-labs.pdf', reportDate: '2025-01-10', additionalValues: [],
  values: [
    { metric: 'ldl', valueSI: 3.23456789, displayValue: 3.2, displayUnit: 'mmol/L', confidence: 'high' },
    { metric: 'hdl', valueSI: 1.23456789, displayValue: 1.2, displayUnit: 'mmol/L', confidence: 'high' },
  ],
}];

// US-02 AC5 / US-13: a visible range error cannot enter a reviewed save,
// nor silently disappear while the rest of the selected panel saves.
describe('ReviewTable range errors before save', () => {
  it.each([
    { metric: 'ldl', unitSystem: 'conventional' as const, lpaUnit: undefined, invalid: '9999', valid: '160' },
    { metric: 'lpa', unitSystem: 'si' as const, lpaUnit: 'mg/L', invalid: '3001', valid: '600' },
    { metric: 'lpa', unitSystem: 'si' as const, lpaUnit: 'mg/dL', invalid: '300.1', valid: '60' },
    { metric: 'lpa', unitSystem: 'si' as const, lpaUnit: 'nmol/L', invalid: '751', valid: '150' },
  ])('blocks $metric in $lpaUnit / $unitSystem and converts only the corrected quantity', ({ metric, unitSystem, lpaUnit, invalid, valid }) => {
    record.lpaUnit = lpaUnit;
    const onSave = vi.fn();
    const upload: FileResult[] = [{ ...files[0], values: [{ ...files[0].values[0], metric, valueSI: metric === 'ldl' ? 3.2 : 124.9 }] }];
    const { container } = render(<ReviewTable grading={{}} results={upload}
      history={{ measurements: [], labValues: [], documents: [] }} unitSystem={unitSystem}
      onSave={onSave} onCancel={() => {}} isSaving={false} error={null} />);
    const input = container.querySelector<HTMLInputElement>('.bt-cell-review input')!;
    const save = container.querySelector<HTMLButtonElement>('.review-save-btn')!;
    fireEvent.change(input, { target: { value: invalid } });
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: valid } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    expect(onSave.mock.calls[0][0].values).toEqual([
      expect.objectContaining({ metric, valueSI: cellToSI(metric === 'ldl' ? 'ldl' : 'lpa', Number(valid), lpaUnit === 'mg/L' ? 'mg/L' : lpaUnit === 'mg/dL' ? 'mg/dL' : lpaUnit === 'nmol/L' ? 'nmol/L' : unitSystem), source: 'lab_import_edited' }),
    ]);
  });

  it('an invalid replacement blocks only while selected; clearing it explicitly excludes it', () => {
    const onSave = vi.fn();
    const { container } = render(<ReviewTable grading={{}} results={files}
      history={{ measurements: [{ id: 'held-ldl', metricType: 'ldl', value: 2.5, recordedAt: '2025-01-10T00:00:00.000Z', createdAt: '2025-01-10T00:00:00.000Z' }], labValues: [], documents: [] }} unitSystem="si"
      onSave={onSave} onCancel={() => {}} isSaving={false} error={null} />);
    const input = container.querySelector<HTMLInputElement>('.bt-cell-review input')!;
    const replace = container.querySelector<HTMLInputElement>('.bt-cell-conflict-replace input')!;
    const save = container.querySelector<HTMLButtonElement>('.review-save-btn')!;
    fireEvent.change(input, { target: { value: '999' } });
    expect(save.disabled).toBe(false);
    fireEvent.click(replace);
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '4.1' } });
    fireEvent.click(save);
    expect(onSave.mock.calls[0][0].values[0]).toMatchObject({ metric: 'ldl', valueSI: 4.1, correctsId: 'held-ldl' });
    onSave.mockClear();
    fireEvent.change(input, { target: { value: '999' } });
    expect(save.disabled).toBe(true);
    fireEvent.change(input, { target: { value: '' } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    expect(onSave.mock.calls[0][0].values).toEqual([expect.objectContaining({ metric: 'hdl', valueSI: 1.23456789 })]);
  });

  it('preserves exact valid extracted precision even for a tiny Lp(a) value rendered as zero', () => {
    const onSave = vi.fn();
    const lpa: FileResult[] = [{ ...files[0], values: [{ ...files[0].values[0], metric: 'lpa', valueSI: 0.0000001 }] }];
    const { container } = render(<ReviewTable grading={{}} results={lpa}
      history={{ measurements: [], labValues: [], documents: [] }} unitSystem="si"
      onSave={onSave} onCancel={() => {}} isSaving={false} error={null} />);
    const save = container.querySelector<HTMLButtonElement>('.review-save-btn')!;
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    expect(onSave.mock.calls[0][0].values[0].valueSI).toBe(0.0000001);
  });

  it('retains the original-unit inline error after a toggle rounds invalid Lp(a) onto the bound', () => {
    const onSave = vi.fn();
    const lpa: FileResult[] = [{ ...files[0], values: [{ ...files[0].values[0], metric: 'lpa', valueSI: 124.9 }] }];
    const { container, getByRole } = render(<ReviewTable grading={{}} results={lpa}
      history={{ measurements: [], labValues: [], documents: [] }} unitSystem="si"
      onSave={onSave} onCancel={() => {}} isSaving={false} error={null} />);
    const input = container.querySelector<HTMLInputElement>('.bt-cell-review input')!;
    fireEvent.change(input, { target: { value: '750.1' } });
    fireEvent.click(getByRole('radio', { name: 'mg/dL' }));
    expect(input.value).toBe('300.0');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    // The visible error describes the input; no title copies it (US-13 AC10).
    // The fixture's printed "3.2 mmol/L" describes it too (US-13 AC11).
    expect(getByRole('textbox', { description: /Max 750 nmol\/L$/ })).toBe(input);
    const save = container.querySelector<HTMLButtonElement>('.review-save-btn')!;
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('rejects an untouched extracted value outside the SI bound even when the display rounds it onto the bound', () => {
    const onSave = vi.fn();
    const lpa: FileResult[] = [{ ...files[0], values: [{ ...files[0].values[0], metric: 'lpa', valueSI: 750.1 }] }];
    const { container } = render(<ReviewTable grading={{}} results={lpa}
      history={{ measurements: [], labValues: [], documents: [] }} unitSystem="si"
      onSave={onSave} onCancel={() => {}} isSaving={false} error={null} />);
    const input = container.querySelector<HTMLInputElement>('.bt-cell-review input')!;
    expect(input.value).toBe('750');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(container.querySelector<HTMLButtonElement>('.review-save-btn')!.disabled).toBe(true);
    fireEvent.click(container.querySelector<HTMLButtonElement>('.review-save-btn')!);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('saves an explicit correction of invalid extraction to its identical rounded rendering through a unit toggle', () => {
    const onSave = vi.fn();
    const lpa: FileResult[] = [{ ...files[0], values: [{ ...files[0].values[0], metric: 'lpa', valueSI: 750.1 }] }];
    const { container, getByRole } = render(<ReviewTable grading={{}} results={lpa}
      history={{ measurements: [], labValues: [], documents: [] }} unitSystem="si"
      onSave={onSave} onCancel={() => {}} isSaving={false} error={null} />);
    const input = container.querySelector<HTMLInputElement>('.bt-cell-review input')!;
    const save = container.querySelector<HTMLButtonElement>('.review-save-btn')!;
    expect(input.value).toBe('750');
    expect(save.disabled).toBe(true);
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.change(input, { target: { value: '750' } });
    expect(input.getAttribute('aria-invalid')).toBe('false');
    expect(save.disabled).toBe(false);
    fireEvent.click(getByRole('radio', { name: 'mg/dL' }));
    expect(input.value).toBe('300.0');
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    expect(onSave.mock.calls[0][0].values).toEqual([
      expect.objectContaining({ metric: 'lpa', valueSI: 750, source: 'lab_import_edited' }),
    ]);
  });

  it('shows no rounded display error for untouched canonical-valid HDL and saves its exact precision', () => {
    const onSave = vi.fn();
    const hdl: FileResult[] = [{ ...files[0], values: [{ ...files[0].values[1], valueSI: 5.2 }] }];
    const { container } = render(<ReviewTable grading={{}} results={hdl}
      history={{ measurements: [], labValues: [], documents: [] }} unitSystem="conventional"
      onSave={onSave} onCancel={() => {}} isSaving={false} error={null} />);
    const input = container.querySelector<HTMLInputElement>('.bt-cell-review input')!;
    const save = container.querySelector<HTMLButtonElement>('.review-save-btn')!;
    expect(input.value).toBe('201');
    expect(input.getAttribute('aria-invalid')).toBe('false');
    expect(container.querySelector('.bt-input-error-text')).toBeNull();
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    expect(onSave.mock.calls[0][0].values).toEqual([
      expect.objectContaining({ metric: 'hdl', valueSI: 5.2, source: undefined }),
    ]);
  });

  it.each([
    { metric: 'lpa', valueSI: 124.9, rendered: '50.0' },
    { metric: 'hdl', valueSI: 5.2, rendered: '201' },
  ])('retyping the valid $metric rendering preserves exact extraction and source', ({ metric, valueSI, rendered }) => {
    const onSave = vi.fn();
    const upload: FileResult[] = [{ ...files[0], values: [{ ...files[0].values[0], metric, valueSI }] }];
    const { container } = render(<ReviewTable grading={{}} results={upload}
      history={{ measurements: [], labValues: [], documents: [] }} unitSystem="conventional"
      onSave={onSave} onCancel={() => {}} isSaving={false} error={null} />);
    const input = container.querySelector<HTMLInputElement>('.bt-cell-review input')!;
    expect(input.value).toBe(rendered);
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.change(input, { target: { value: rendered } });
    expect(input.getAttribute('aria-invalid')).toBe('false');
    fireEvent.click(container.querySelector<HTMLButtonElement>('.review-save-btn')!);
    expect(onSave.mock.calls[0][0].values).toEqual([
      expect.objectContaining({ metric, valueSI, source: undefined }),
    ]);
  });

  it('validates an invalid extraction after date movement and accepts its explicit rounded correction at the new date', () => {
    const onSave = vi.fn();
    const lpa: FileResult[] = [{ ...files[0], values: [{ ...files[0].values[0], metric: 'lpa', valueSI: 750.1 }] }];
    const { container, getByLabelText } = render(<ReviewTable grading={{}} results={lpa}
      history={{ measurements: [], labValues: [], documents: [] }} unitSystem="si"
      onSave={onSave} onCancel={() => {}} isSaving={false} error={null} />);
    fireEvent.change(getByLabelText('Choose column date'), { target: { value: '2025-02-15' } });
    const input = container.querySelector<HTMLInputElement>('.bt-cell-review input')!;
    const save = container.querySelector<HTMLButtonElement>('.review-save-btn')!;
    expect(input.value).toBe('750');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(save.disabled).toBe(true);
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.change(input, { target: { value: '750' } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    expect(onSave.mock.calls[0][0].values).toEqual([
      expect.objectContaining({ metric: 'lpa', valueSI: 750, source: 'lab_import_edited', recordedAt: '2025-02-15T00:00:00.000Z' }),
    ]);
  });

  it('blocks a mixed panel with invalid SI LDL, keeps the input recoverable, and saves the correction', () => {
    const onSave = vi.fn();
    const { container } = render(<ReviewTable grading={{}} results={files}
      history={{ measurements: [], labValues: [], documents: [] }} unitSystem="si"
      onSave={onSave} onCancel={() => {}} isSaving={false} error={null} />);
    const input = container.querySelector<HTMLInputElement>('.bt-cell-review input')!;
    const save = container.querySelector<HTMLButtonElement>('.review-save-btn')!;
    fireEvent.change(input, { target: { value: '999' } });
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    expect(onSave).not.toHaveBeenCalled();
    expect(input.value).toBe('999');
    fireEvent.change(input, { target: { value: '4.1' } });
    expect(input.getAttribute('aria-invalid')).toBe('false');
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    expect(onSave.mock.calls[0][0].values).toEqual([
      { metric: 'ldl', valueSI: 4.1, source: 'lab_import_edited', recordedAt: '2025-01-10T00:00:00.000Z', correctsId: undefined },
      { metric: 'hdl', valueSI: 1.23456789, source: undefined, recordedAt: '2025-01-10T00:00:00.000Z', correctsId: undefined },
    ]);
  });
});
