// @vitest-environment jsdom
// US-13 AC8: a new column saves only on a calendar day that has happened.
// Rows are append-only, so a misread date saved once is there for good.
// Cases from the review rounds on PR #152 (branch austin-batch-2026-10-19).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { ReviewTable, type FileResult } from './ReviewTable';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-15T12:00:00Z')); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

function review(reportDate: string | null) {
  const result: FileResult = { fileName: 'synthetic-labs.pdf', reportDate, additionalValues: [],
    values: [{ metric: 'ldl', valueSI: 3, displayValue: 3, displayUnit: 'mmol/L', confidence: 'high' }] };
  const onSave = vi.fn();
  const view = render(<ReviewTable results={[result]} history={{ measurements: [], labValues: [], documents: [] }}
    unitSystem="si" age={60} sex="male" grading={{}} onSave={onSave} onCancel={() => {}} isSaving={false} error={null} />);
  const save = view.getByRole('button', { name: /^Save / }) as HTMLButtonElement;
  const picker = () => view.getByLabelText('Choose column date') as HTMLInputElement;
  return { view, onSave, save, picker };
}

describe('US-13 AC8: a new column date is a past calendar day before Save', () => {
  it.each(['2024-13', '2027-03', 'June 2024', null, '2027-03-15', '2024-15-06', '2024-02-30', '2024-06'])(
    'an extracted %s needs a day: an empty picker, no Use, Save disabled, until the user picks one', reportDate => {
      const { view, onSave, save, picker } = review(reportDate);
      expect(picker().value).toBe('');
      expect(view.queryByRole('button', { name: /^Use / })).toBeNull();
      expect(save.disabled).toBe(true);
      expect(view.container.querySelector('.bt-header-row')?.textContent).not.toContain('NaN');
      fireEvent.click(save);
      expect(onSave).not.toHaveBeenCalled();
      fireEvent.change(picker(), { target: { value: '2024-06-12' } });
      expect(save.disabled).toBe(false);
      fireEvent.click(save);
      expect(onSave.mock.calls[0][0].values[0].recordedAt).toBe('2024-06-12T00:00:00.000Z');
    });

  it('a printed month can be confirmed on its 1st: the picker starts empty, so that day fires a change', () => {
    const { onSave, save, picker } = review('2024-06');
    fireEvent.change(picker(), { target: { value: '2024-06-01' } });
    fireEvent.click(save);
    expect(onSave.mock.calls[0][0].values[0].recordedAt).toBe('2024-06-01T00:00:00.000Z');
  });

  it('a valid past day saves with no click, as before', () => {
    const { onSave, save } = review('2024-06-10');
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    expect(onSave.mock.calls[0][0].values[0].recordedAt).toBe('2024-06-10T00:00:00.000Z');
  });

  it('a valid day changed to the future disables Save again', () => {
    const { onSave, save, picker } = review('2024-06-10');
    fireEvent.change(picker(), { target: { value: '2027-01-05' } });
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('today counts as a day that has happened', () => {
    const { save } = review('2026-10-15');
    expect(save.disabled).toBe(false);
  });

  it('the column header stays one element, so later headers stay over their values', () => {
    const { view } = review(null);
    const strip = view.container.querySelector('.bt-header-row .bt-strip-inner')!;
    // One header per column, then the spacer.
    expect(strip.children).toHaveLength(2);
  });
});
