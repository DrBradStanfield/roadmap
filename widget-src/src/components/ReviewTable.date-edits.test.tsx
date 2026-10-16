// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { ReviewTable, type FileResult } from './ReviewTable';

afterEach(cleanup);
const file: FileResult = {
  fileName: 'synthetic.pdf', reportDate: '2024-06-01',
  values: [{ metric: 'ldl', valueSI: 3.2, displayValue: 3.2, displayUnit: 'mmol/L', confidence: 'high' }],
  additionalValues: [],
  file: new Blob(['synthetic'], { type: 'application/pdf' }),
};
function setup(files = [file], history: React.ComponentProps<typeof ReviewTable>['history'] = { measurements: [], labValues: [], documents: [] }) {
  const onSave = vi.fn();
  const el = (unitSystem: 'si' | 'conventional') => <ReviewTable grading={{}} results={files} history={history}
    unitSystem={unitSystem} onSave={onSave} onCancel={() => {}} isSaving={false} error={null} />;
  const view = render(el('si'));
  return {
    ...view,
    input: () => view.container.querySelector<HTMLInputElement>('.bt-cell-review input')!,
    date: (value: string) => fireEvent.change(view.getAllByLabelText('Choose column date')[0], { target: { value } }),
    toggle: () => view.rerender(el('conventional')),
    save: () => {
      fireEvent.click(view.container.querySelector('.review-save-btn')!);
      expect(onSave).toHaveBeenCalledTimes(1);
      return onSave.mock.calls[0][0];
    },
    onSave,
  };
}

describe('US-13 AC2/AC4: review intent survives column date edits', () => {
  it('saves the corrected value on the reviewed date, not the extracted value', () => {
    const c = setup();
    fireEvent.change(c.input(), { target: { value: '2.1' } });
    c.date('2024-06-02');
    expect(c.input().value).toBe('2.1');
    expect(c.save().values).toEqual([expect.objectContaining({ valueSI: 2.1, recordedAt: '2024-06-02T00:00:00.000Z', source: 'lab_import_edited' })]);
  });

  it('keeps clear-to-exclude through repeated date edits and a unit toggle', () => {
    const c = setup();
    fireEvent.change(c.input(), { target: { value: '' } });
    c.date('2024-06-02');
    c.toggle();
    c.date('2024-06-03');
    expect(c.input().value).toBe('');
    expect(c.save().values).toEqual([]);
  });

  it('keeps the typed unit through a toggle before a date edit', () => {
    const c = setup();
    fireEvent.change(c.input(), { target: { value: '2.1' } });
    c.toggle();
    c.date('2024-06-02');
    expect(c.save().values[0]).toMatchObject({ valueSI: 2.1, source: 'lab_import_edited' });
  });

  it.each(['7', ''])('keeps additional-lab review text %j on the new date', (text) => {
    const c = setup([{ ...file, values: [], additionalValues: [{ name: 'Synthetic test', value: 12, unit: 'U/L' }] }]);
    fireEvent.change(c.input(), { target: { value: text } });
    c.date('2024-06-02');
    expect(c.input().value).toBe(text);
    const saved = c.save().labValues;
    expect(saved).toEqual(text ? [expect.objectContaining({ value: 7, unit: 'U/L', recordedAt: '2024-06-02T00:00:00.000Z' })] : []);
  });

  it('keeps untouched canonical precision on a new date after a unit toggle', () => {
    const c = setup([{ ...file, values: [{ metric: 'lpa', valueSI: 124.9, displayValue: 124.9, displayUnit: 'nmol/L', confidence: 'high' }] }]);
    c.toggle();
    c.date('2024-06-02');
    expect(c.save().values[0]).toMatchObject({ valueSI: 124.9, source: undefined, correctsId: undefined });
  });

  it('shows the corrected quantity after changing date then toggling units', () => {
    const c = setup();
    fireEvent.change(c.input(), { target: { value: '2.1' } });
    c.date('2024-06-02');
    c.toggle();
    expect(c.input().value).not.toBe('2.1');
    expect(c.save().values[0]).toMatchObject({ valueSI: 2.1, source: 'lab_import_edited' });
  });

  it('moves a replacement to an empty slot as a first creation without old permission', () => {
    const c = setup([file], { measurements: [{ id: 'old', metricType: 'ldl', value: 4, recordedAt: '2024-06-01T00:00:00.000Z', createdAt: '2024-06-01T00:00:00.000Z' }], labValues: [], documents: [] });
    fireEvent.click(c.getByRole('checkbox'));
    fireEvent.change(c.input(), { target: { value: '2.1' } });
    c.date('2024-06-03');
    expect(c.save().values).toEqual([expect.objectContaining({ valueSI: 2.1, correctsId: undefined, recordedAt: '2024-06-03T00:00:00.000Z' })]);
  });

  it('moves every contributing file in a shared column without losing a cell', () => {
    const c = setup([file, { ...file, fileName: 'other.pdf', values: [], additionalValues: [{ name: 'Synthetic test', value: 12, unit: 'U/L' }] }]);
    fireEvent.change(c.input(), { target: { value: '2.1' } });
    c.date('2024-06-02');
    const payload = c.save();
    expect(payload.values[0]).toMatchObject({ valueSI: 2.1, recordedAt: '2024-06-02T00:00:00.000Z' });
    expect(payload.labValues[0]).toMatchObject({ value: 12, recordedAt: '2024-06-02T00:00:00.000Z' });
  });

  it('refuses merging upload columns rather than dropping either reviewed value', () => {
    const c = setup([file, { ...file, fileName: 'second.pdf', reportDate: '2024-06-02' }]);
    fireEvent.change(c.input(), { target: { value: '2.1' } });
    c.date('2024-06-02');
    expect(c.getByRole('alert').textContent).toContain('already has a column');
    expect(c.save().values.map((v: { valueSI: number }) => v.valueSI)).toEqual([2.1, 3.2]);
  });

  it('leaves replacement permission on an unrelated, unmoved column alone', () => {
    const held = (id: string, day: string) => ({ id, metricType: 'ldl' as const, value: 4, recordedAt: `${day}T00:00:00.000Z`, createdAt: `${day}T00:00:00.000Z` });
    const c = setup([file, { ...file, reportDate: '2024-06-02', fileName: 'second.pdf' }], { measurements: [held('first', '2024-06-01'), held('second', '2024-06-02')], labValues: [], documents: [] });
    for (const checkbox of c.getAllByRole('checkbox')) fireEvent.click(checkbox);
    c.date('2024-06-03');
    expect(c.save().values).toEqual(expect.arrayContaining([
      expect.objectContaining({ correctsId: 'second', recordedAt: '2024-06-02T00:00:00.000Z' }),
      expect.objectContaining({ correctsId: undefined, recordedAt: '2024-06-03T00:00:00.000Z' }),
    ]));
  });

  it('does not move replacement permission onto another history slot', () => {
    const held = (id: string, day: string) => ({ id, metricType: 'ldl' as const, value: 4, recordedAt: `${day}T00:00:00.000Z`, createdAt: `${day}T00:00:00.000Z` });
    const c = setup([file], { measurements: [held('old', '2024-06-01'), held('other', '2024-06-02')], labValues: [], documents: [] });
    fireEvent.click(c.getByRole('checkbox'));
    fireEvent.change(c.input(), { target: { value: '2.1' } });
    c.date('2024-06-02');
    expect(c.getByRole('alert').textContent).toContain('already has a column');
    expect(c.save().values).toEqual([expect.objectContaining({ valueSI: 2.1, correctsId: 'old', recordedAt: '2024-06-01T00:00:00.000Z' })]);
  });
});
