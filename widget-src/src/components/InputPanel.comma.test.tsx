// @vitest-environment jsdom
/**
 * US-02 AC7 (Codex R1, data loss): a type="number" box the browser cannot read
 * ("175,500" in an English locale) hands its handler "" with validity.badInput
 * set. That is text the person typed, not a clear: the saved value stays, the
 * box says "Enter a number", and blur saves nothing. Only a truly empty box
 * clears. Before, the "" cleared the saved height.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { InputPanel } from './InputPanel';

vi.mock('../lib/server-api', async importOriginal => ({ ...await importOriginal<typeof import('../lib/server-api')>(), trackProductEvent: vi.fn() }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

afterEach(cleanup);
// InputPanel reads the phone breakpoint (US-62 AC8); jsdom has no matchMedia. Desktop unless a test sets `phone`.
let phone = false;
vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('max-width') ? phone : !phone, media: q, addEventListener() {}, removeEventListener() {} }));
afterEach(() => { phone = false; });

const renderPanel = () => {
  const inputs = { sex: 'male' as const, heightCm: 180, birthYear: 1960, birthMonth: 1, weightKg: 80, waistCm: 90, psa: 2 };
  const onChange = vi.fn();
  const onScreeningChange = vi.fn();
  const scheduleLongitudinalSave = vi.fn();
  const props = {
    inputs, effectiveInputs: inputs, onChange, errors: {}, unitSystem: 'si' as const, onUnitSystemChange: vi.fn(),
    unitOverrides: {}, onToggleFieldUnit: vi.fn(), previousMeasurements: [], bloodTestHistory: [], vitalsHistory: [],
    labValues: [], onSaveBloodTestBatch: vi.fn(async () => new Map()), onDraftValue: vi.fn(), medications: [],
    onMedicationChange: vi.fn(), onScreeningChange, supplements: [], onSupplementChange: vi.fn(),
    screenings: [
      { id: 's1', screeningKey: 'prostate_discussion', value: 'will_screen', updatedAt: '' },
      { id: 's2', screeningKey: 'lung_smoking_history', value: 'former_smoker', updatedAt: '' },
      { id: 's3', screeningKey: 'lung_pack_years', value: '25', updatedAt: '' },
    ],
    onSupplementDelete: vi.fn(), scheduleLongitudinalSave, flushLongitudinalSave: vi.fn(), isSavingLongitudinal: false,
    fieldsSaved: 0, hasApiResponse: true, formStage: 3 as const, planBasis: { age: 66 }, grading: {},
  };
  const view = render(<InputPanel {...(props as unknown as Parameters<typeof InputPanel>[0])} />);
  const box = (id: string) => view.container.querySelector<HTMLInputElement>(`#${id}`)!;
  return { ...view, box, onChange, onScreeningChange, scheduleLongitudinalSave };
};

/** What a browser hands the handler for "175,500" in a type="number" box. */
const typeUnreadable = (input: HTMLInputElement) => {
  Object.defineProperty(input, 'validity', { configurable: true, value: { ...input.validity, badInput: true } });
  fireEvent.change(input, { target: { value: '' } });
};
const typeEmpty = (input: HTMLInputElement) => {
  Object.defineProperty(input, 'validity', { configurable: true, value: { ...input.validity, badInput: false } });
  fireEvent.change(input, { target: { value: '' } });
};
const callsFor = (fn: ReturnType<typeof vi.fn>, field: string) => fn.mock.calls.filter(([f]) => f === field);

describe('US-02 AC7: an unreadable number box is not a clear', () => {
  it('a type="number" box hands its handler "" for "175,500" (the HTML value sanitizer)', () => {
    const input = document.createElement('input');
    input.type = 'number';
    input.value = '175,500';
    expect(input.value).toBe('');
  });

  it.each(['heightCm', 'weightKg', 'waistCm', 'psa'])('%s: unreadable text keeps the saved value, says so, and blur saves nothing', field => {
    const p = renderPanel();
    const input = p.box(field === 'psa' ? 'psa-input' : field);
    expect(input).not.toBeNull();
    typeUnreadable(input);
    expect(callsFor(p.onChange, field)).toEqual([]);
    expect(p.getByText('Enter a number')).toBeTruthy();
    fireEvent.blur(input);
    expect(p.scheduleLongitudinalSave).not.toHaveBeenCalled();
    expect(callsFor(p.onChange, field)).toEqual([]);
  });

  it.each(['heightCm', 'weightKg', 'waistCm', 'psa'])('%s: an emptied box clears', field => {
    const p = renderPanel();
    typeEmpty(p.box(field === 'psa' ? 'psa-input' : field));
    expect(callsFor(p.onChange, field).at(-1)!.slice(0, 2)).toEqual([field, undefined]);
    expect(p.queryByText('Enter a number')).toBeNull();
  });

  it('pack-years: unreadable text writes nothing and says so; an emptied box clears', () => {
    const p = renderPanel();
    typeUnreadable(p.box('lung-pack-years'));
    expect(p.onScreeningChange).not.toHaveBeenCalled();
    expect(p.getByText('Enter a number')).toBeTruthy();
    typeEmpty(p.box('lung-pack-years'));
    expect(p.onScreeningChange).toHaveBeenLastCalledWith('lung_pack_years', '');
  });
});

// US-62 AC12: on a phone, About you sits low; its height box keeps the same rule.
it('on a phone too, an unreadable height keeps the saved value', () => {
  phone = true;
  const p = renderPanel();
  expect(p.container.querySelector('.md-about-you #heightCm')).not.toBeNull();
  typeUnreadable(p.box('heightCm'));
  expect(callsFor(p.onChange, 'heightCm')).toEqual([]);
  expect(p.getByText('Enter a number')).toBeTruthy();
});
