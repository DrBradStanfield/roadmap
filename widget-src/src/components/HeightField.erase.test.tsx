// @vitest-environment jsdom
/**
 * US-02 AC11a: in feet and inches, the height boxes are empty once the form
 * holds no height, as after "Delete all my data" (HealthTool's forgetRecord
 * empties the form). Before, they kept the erased height, full to their
 * maxLength, so typing the same height again changed nothing and saved
 * nothing. Synthetic values only.
 */
import { useState } from 'react';
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { InputPanel } from './InputPanel';
import { myHealth } from '../testing/my-health-props';
import type { HealthInputs } from '@roadmap/health-core/types';

vi.mock('../lib/server-api', async importOriginal => ({ ...await importOriginal<typeof import('../lib/server-api')>(), trackProductEvent: vi.fn() }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

afterEach(cleanup);
vi.stubGlobal('matchMedia', (q: string) => ({ matches: !q.includes('max-width'), media: q, addEventListener() {}, removeEventListener() {} }));

/** The onboarding's first question, height and weight, as a new record shows it. */
const props = (inputs: Partial<HealthInputs>, onChange: (field: keyof HealthInputs, value: unknown) => void, unitSystem: 'si' | 'conventional') => ({
  ...myHealth(),
  inputs, effectiveInputs: inputs, onChange, errors: {}, unitSystem,
  unitOverrides: {}, onToggleFieldUnit: vi.fn(), previousMeasurements: [], bloodTestHistory: [], vitalsHistory: [],
  labValues: [], onSaveBloodTestBatch: vi.fn(async () => new Map()), medications: [],
  onMedicationChange: vi.fn(), onScreeningChange: vi.fn(), supplements: [], onSupplementChange: vi.fn(), screenings: [],
  onSupplementDelete: vi.fn(), scheduleLongitudinalSave: vi.fn(), flushLongitudinalSave: vi.fn(), isSavingLongitudinal: false,
  hasApiResponse: true, onboarding: { stage: 1 as const, reached: 1 as const, fullForm: false, aboutYouLow: false }, planBasis: null, grading: {},
}) as unknown as Parameters<typeof InputPanel>[0];

/** The form's heights as sent, and a way to replace the whole form from outside it (an erase, a re-read). */
let sent: Array<number | undefined> = [];
let replaceForm: (next: Partial<HealthInputs>) => void = () => {};
function Panel({ start, unitSystem }: { start: Partial<HealthInputs>; unitSystem: 'si' | 'conventional' }) {
  const [inputs, setInputs] = useState(start);
  replaceForm = setInputs;
  const onChange = (field: keyof HealthInputs, value: unknown) => {
    if (field === 'heightCm') sent.push(value as number | undefined);
    setInputs(prev => ({ ...prev, [field]: value }));
  };
  return <InputPanel {...props(inputs, onChange, unitSystem)}/>;
}

const box = (c: HTMLElement, id: string) => c.querySelector<HTMLInputElement>(`#${id}`)!;
const boxes = (c: HTMLElement) => [box(c, 'heightFeet').value, box(c, 'heightInches').value];
/** One box's keys, as a person types them at the end of what it shows; a full box takes none (its maxLength). */
const typeInto = (input: HTMLInputElement, keys: string) => {
  const next = (input.value + keys).slice(0, input.maxLength);
  if (next !== input.value) fireEvent.change(input, { target: { value: next } });
};
const erase = () => act(() => replaceForm({})); // forgetRecord's setInputs({})

afterEach(() => { sent = []; });

it('US-02 AC11a: after an erase the feet and inches boxes are empty, and 5 ft 10 in typed again is sent', () => {
  const { container: c } = render(<Panel start={{ heightCm: 177.8 }} unitSystem="conventional"/>);
  expect(boxes(c)).toEqual(['5', '10']); // the record's height, shown on load

  erase();
  expect(boxes(c)).toEqual(['', '']);

  typeInto(box(c, 'heightFeet'), '5');
  typeInto(box(c, 'heightInches'), '10');
  expect(boxes(c)).toEqual(['5', '10']);
  expect(sent.at(-1)).toBeCloseTo(177.8, 1);
});

it('US-02 AC11a: a height typed in this tab is emptied by the erase too, and the same height from elsewhere afterwards shows', () => {
  const { container: c } = render(<Panel start={{}} unitSystem="conventional"/>);
  typeInto(box(c, 'heightFeet'), '5');
  typeInto(box(c, 'heightInches'), '10');
  expect(sent.at(-1)).toBeCloseTo(177.8, 1);

  erase();
  expect(boxes(c)).toEqual(['', '']);

  // Another device saves 5 ft 10 in after the erase; the re-read brings it here.
  act(() => replaceForm({ heightCm: sent.at(-1) }));
  expect(boxes(c)).toEqual(['5', '10']);
});

it('US-02 AC11 unchanged: emptying both boxes by hand leaves them empty, and a 0 or inches typed alone stay as typed', () => {
  const { container: c } = render(<Panel start={{ heightCm: 177.8 }} unitSystem="conventional"/>);
  fireEvent.change(box(c, 'heightFeet'), { target: { value: '' } });
  expect(boxes(c)).toEqual(['', '10']);
  fireEvent.change(box(c, 'heightInches'), { target: { value: '' } });
  expect(boxes(c)).toEqual(['', '']);
  expect(sent.at(-1)).toBeUndefined();

  typeInto(box(c, 'heightFeet'), '0'); // feet "0": the form's height is 0, not none, so the boxes keep it
  expect(sent.at(-1)).toBe(0);
  expect(boxes(c)).toEqual(['0', '']);
  fireEvent.change(box(c, 'heightFeet'), { target: { value: '' } });
  typeInto(box(c, 'heightInches'), '8');
  expect(boxes(c)).toEqual(['', '8']);
});

it('US-02 AC11a: in cm the box is empty after an erase, as before', () => {
  const { container: c } = render(<Panel start={{ heightCm: 178 }} unitSystem="si"/>);
  expect(box(c, 'heightCm').value).toBe('178');
  erase();
  expect(box(c, 'heightCm').value).toBe('');
});
