// @vitest-environment jsdom
/**
 * US-02 AC7 (Codex R1, data loss): the profile height and the first-time
 * weight and waist read a typed comma by the field's range, as the matrices
 * do, and a value they refuse never clears the one held. Only an emptied box
 * clears. Before, they were type="number" boxes: a browser hands such a box's
 * handler "" for "175,500", and "" cleared the saved height.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { InputPanel } from './InputPanel';

vi.mock('../lib/server-api', async importOriginal => ({ ...await importOriginal<typeof import('../lib/server-api')>(), trackProductEvent: vi.fn() }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

afterEach(cleanup);

const renderPanel = () => {
  const inputs = { sex: 'male' as const, heightCm: 180, birthYear: 1960, birthMonth: 1 };
  const onChange = vi.fn();
  const props = {
    inputs, effectiveInputs: inputs, onChange, errors: {}, unitSystem: 'si' as const, onUnitSystemChange: vi.fn(),
    unitOverrides: {}, onToggleFieldUnit: vi.fn(), previousMeasurements: [], bloodTestHistory: [], vitalsHistory: [],
    labValues: [], onSaveBloodTestBatch: vi.fn(async () => new Map()), onDraftValue: vi.fn(), medications: [],
    onMedicationChange: vi.fn(), screenings: [], onScreeningChange: vi.fn(), supplements: [], onSupplementChange: vi.fn(),
    onSupplementDelete: vi.fn(), scheduleLongitudinalSave: vi.fn(), flushLongitudinalSave: vi.fn(), isSavingLongitudinal: false,
    fieldsSaved: 0, hasApiResponse: false, formStage: 3 as const, planBasis: { age: 66 }, grading: {},
  };
  const view = render(<InputPanel {...(props as unknown as Parameters<typeof InputPanel>[0])} />);
  const box = (id: string) => view.container.querySelector<HTMLInputElement>(`#${id}`)!;
  return { ...view, box, onChange };
};

describe('US-02 AC7: the profile height and first-time vitals refuse, never clear', () => {
  it('a type="number" box hands its handler "" for "175,500" (the HTML value sanitizer)', () => {
    const input = document.createElement('input');
    input.type = 'number';
    input.value = '175,500';
    expect(input.value).toBe('');
  });

  it('height "175,500" cm asks and keeps the saved height; an emptied box clears it', () => {
    const p = renderPanel();
    fireEvent.change(p.box('heightCm'), { target: { value: '175,500' } });
    expect(p.onChange.mock.calls.filter(([field]) => field === 'heightCm')).toEqual([]);
    expect(p.getByText('Did you mean 175500 or 175.5?')).toBeTruthy();
    fireEvent.change(p.box('heightCm'), { target: { value: '175,5' } });
    expect(p.onChange.mock.calls.at(-1)!.slice(0, 2)).toEqual(['heightCm', 175.5]);
    expect(p.queryByText('Did you mean 175500 or 175.5?')).toBeNull();
    fireEvent.change(p.box('heightCm'), { target: { value: '' } });
    expect(p.onChange.mock.calls.at(-1)!.slice(0, 2)).toEqual(['heightCm', undefined]);
  });

  it('a first weight of "1,234" kg asks and writes nothing', () => {
    const p = renderPanel();
    expect(p.box('weightKg')).not.toBeNull();
    fireEvent.change(p.box('weightKg'), { target: { value: '1,234' } });
    expect(p.onChange.mock.calls.filter(([field]) => field === 'weightKg')).toEqual([]);
    expect(p.getByText('Did you mean 1234 or 1.234?')).toBeTruthy();
  });
});
