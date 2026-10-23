// @vitest-environment jsdom
/**
 * US-12 / US-13 characterisation pins (plan docs/reviews/2026-10-23-mcp-dedup-plan.md,
 * step 1): the `ReviewedValue` / `ReviewedLabValue` rows ReviewTable's Save
 * hands up, byte for byte — an edited value (`lab_import_edited`), an
 * undated previous column on the picked day, a ticked Replace, and a value
 * typed in the other unit. A later de-dup must leave every pin alone.
 * UploadModal.pins.test.tsx pins the store inputs these become. Synthetic values.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import type { ApiMeasurement } from '@roadmap/health-core';
import type { ApiLabValue } from '../lib/api-types';
import { ReviewTable, type FileResult } from './ReviewTable';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-15T12:00:00Z')); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

const v = (metric: string, valueSI: number, recordedAt?: string, displayUnit = 'mmol/L') =>
  ({ metric, valueSI, displayValue: valueSI, displayUnit, confidence: 'high' as const, ...(recordedAt ? { recordedAt } : {}) });

function review(results: FileResult[], measurements: ApiMeasurement[] = [], labValues: ApiLabValue[] = [], overrides?: Record<string, 'si' | 'conventional'>) {
  const onSave = vi.fn();
  const view = render(<ReviewTable grading={{}} results={results} history={{ measurements, labValues, documents: [] }}
    unitSystem="si" metricUnitOverrides={overrides} onSave={onSave} onCancel={() => {}} isSaving={false} error={null} />);
  const input = (value: string) => Array.from(view.container.querySelectorAll<HTMLInputElement>('.bt-cell-input input')).find(i => i.value === value)!;
  const save = () => fireEvent.click(view.getByRole('button', { name: /^Save/ }));
  /** The rows Save handed up, as JSON: the pin. */
  const saved = () => {
    const { values, labValues: labs } = onSave.mock.calls[0][0];
    return JSON.stringify({ values, labValues: labs });
  };
  return { view, input, save, saved };
}

describe('US-12 / US-13 pins — ReviewTable Save hands up the same rows as today', () => {
  it('a report with core and additional values, one core value edited', () => {
    const t = review([{ fileName: 'labs.pdf', reportDate: '2026-03-10', values: [v('ldl', 2.8), v('hdl', 1.2)],
      additionalValues: [{ name: 'Ferritin', value: 85, unit: 'µg/L', referenceLow: 30, referenceHigh: 300 }, { name: 'Sodium', value: 140, unit: 'mmol/L' }] }]);
    fireEvent.change(t.input('2.8'), { target: { value: '2.9' } });
    t.save();
    expect(t.saved()).toMatchSnapshot();
  });

  it('an undated previous column saves on the picked day', () => {
    const t = review([{ fileName: 'baseline.docx', reportDate: '2026-03-10',
      values: [v('ldl', 2.6), v('ldl', 3.4, 'undated'), v('hdl', 1.2, 'undated')],
      additionalValues: [{ name: 'sodium', value: 139, unit: 'mmol/L', recordedAt: 'undated' }] }]);
    fireEvent.change(t.view.getByLabelText('Choose the date of the previous results'), { target: { value: '2025-09-02' } });
    t.save();
    expect(t.saved()).toMatchSnapshot();
  });

  it('a ticked Replace carries the held row ids', () => {
    const t = review([{ fileName: 'labs.pdf', reportDate: '2025-09-02', values: [v('hdl', 1.4)], additionalValues: [{ name: 'Ferritin', value: 90, unit: 'µg/L' }] }],
      [{ id: 'H', metricType: 'hdl', value: 1.2, recordedAt: '2025-09-02T00:00:00.000Z', createdAt: '2025-09-02T00:00:00.000Z' }],
      [{ id: 'F', metricName: 'ferritin', value: 70, unit: 'µg/L', referenceLow: null, referenceHigh: null, recordedAt: '2025-09-02T00:00:00.000Z', source: 'lab_import', createdAt: '2025-09-02T00:00:00.000Z' }]);
    for (const box of t.view.queryAllByRole('checkbox', { name: /Replace the saved/ })) fireEvent.click(box);
    t.save();
    expect(t.saved()).toMatchSnapshot();
  });

  it('a value typed in the other unit (the LDL toggle set to mg/dL) saves in SI', () => {
    const t = review([{ fileName: 'labs.pdf', reportDate: '2026-03-10', values: [v('ldl', 2.8)], additionalValues: [] }], [], [], { ldl: 'conventional' });
    const shown = Array.from(t.view.container.querySelectorAll<HTMLInputElement>('.bt-cell-input input'))[0];
    fireEvent.change(shown, { target: { value: '120' } });
    t.save();
    expect(`${shown.value} → ${t.saved()}`).toMatchSnapshot();
  });
});
