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

// US-13 AC12 / US-02 AC7: "1,234" in a review cell is read in the unit it was
// typed in, or asked about, and an asked cell blocks Save.
describe('ReviewTable: an ambiguous comma (US-13 AC12)', () => {
  const review = (upload: FileResult[], unitSystem: 'si' | 'conventional') => {
    const onSave = vi.fn();
    const view = render(<ReviewTable grading={{}} results={upload}
      history={{ measurements: [], labValues: [], documents: [] }} unitSystem={unitSystem}
      onSave={onSave} onCancel={() => {}} isSaving={false} error={null} />);
    const input = view.container.querySelector<HTMLInputElement>('.bt-cell-review input')!;
    const save = view.container.querySelector<HTMLButtonElement>('.review-save-btn')!;
    return { ...view, onSave, input, save };
  };
  const tg: FileResult[] = [{ ...files[0], values: [{ metric: 'triglycerides', valueSI: 1.5, displayValue: 1.5, displayUnit: 'mmol/L', confidence: 'high' }] }];

  it('asks in mg/dL, where 1234 and 1.234 are both in range, and blocks Save', () => {
    const r = review(tg, 'conventional');
    fireEvent.change(r.input, { target: { value: '1,234' } });
    expect(r.input.getAttribute('aria-invalid')).toBe('true');
    expect(r.getByText('Did you mean 1234 or 1.234?')).toBeTruthy();
    expect(r.save.disabled).toBe(true);
    fireEvent.click(r.save);
    expect(r.onSave).not.toHaveBeenCalled();
  });

  // Adversary R1: in mmol/L only 1.234 fits, a decimal reading, which is never chosen.
  it('asks in SI too, where only the decimal reading is in range', () => {
    const r = review(tg, 'si');
    fireEvent.change(r.input, { target: { value: '1,234' } });
    expect(r.input.getAttribute('aria-invalid')).toBe('true');
    expect(r.save.disabled).toBe(true);
  });

  it('saves 1234 µmol/L creatinine, where the decimal reading is below the range', () => {
    const r = review([{ ...files[0], values: [{ metric: 'creatinine', valueSI: 80, displayValue: 80, displayUnit: 'µmol/L', confidence: 'high' }] }], 'si');
    fireEvent.change(r.input, { target: { value: '1,234' } });
    expect(r.input.getAttribute('aria-invalid')).toBe('false');
    fireEvent.click(r.save);
    expect(r.onSave.mock.calls[0][0].values).toEqual([expect.objectContaining({ metric: 'creatinine', valueSI: 1234, source: 'lab_import_edited' })]);
  });

  it('asks on a lab row, which has no range, and blocks Save until it is retyped', () => {
    const r = review([{ ...files[0], values: [], additionalValues: [{ name: 'Ferritin', value: 45, unit: 'µg/L' }] }], 'si');
    fireEvent.change(r.input, { target: { value: '1,050' } });
    expect(r.getByText('Did you mean 1050 or 1.05?')).toBeTruthy();
    expect(r.save.disabled).toBe(true);
    fireEvent.change(r.input, { target: { value: '1,05' } });
    expect(r.save.disabled).toBe(false);
    fireEvent.click(r.save);
    expect(r.onSave.mock.calls[0][0].labValues).toEqual([expect.objectContaining({ value: 1.05 })]);
  });

  // Codex R2: a lab row has no range to check grouped thousands, so they block Save.
  it('refuses "1,234,567" on a lab row and asks for it without commas', () => {
    const r = review([{ ...files[0], values: [], additionalValues: [{ name: 'Ferritin', value: 45, unit: 'µg/L' }] }], 'si');
    fireEvent.change(r.input, { target: { value: '1,234,567' } });
    expect(r.getByText('Type the number without commas.')).toBeTruthy();
    expect(r.save.disabled).toBe(true);
  });
});
