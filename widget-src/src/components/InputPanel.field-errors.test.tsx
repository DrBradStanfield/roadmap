// @vitest-environment jsdom
/**
 * US-02 AC5a: an error shown under a box in About you, the onboarding's weight or the prostate and lung questions is
 * tied to that box, as the matrices' cells do: the box is aria-invalid and its description is the error's text, so a
 * screen reader says why when the box is reached again. With no error, neither is set. Synthetic values.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { InputPanel } from './InputPanel';
import { myHealth } from '../testing/my-health-props';
import { openAboutYou } from '../testing/health-tool-harness';

vi.mock('../lib/server-api', async importOriginal => ({ ...await importOriginal<typeof import('../lib/server-api')>(), trackProductEvent: vi.fn() }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.stubGlobal('matchMedia', (q: string) => ({ matches: !q.includes('max-width'), media: q, addEventListener() {}, removeEventListener() {} }));
afterEach(cleanup);

const DONE = { stage: 4 as const, reached: 4 as const, fullForm: true, aboutYouLow: true };
/** The onboarding's weight box, beside the height, before the whole form opens (US-62 AC13). */
const WEIGHT_BOX = { stage: 1 as const, reached: 1 as const, fullForm: false, aboutYouLow: false };
const SAVED_WEIGHT = [{ id: 'w1', metricType: 'weight', value: 80, recordedAt: '2026-01-02T09:00:00.000Z', createdAt: '2026-01-02T09:00:00.000Z' }];

function renderPanel({ errors = {}, unitSystem = 'si', onboarding = DONE, previousMeasurements = [], weightKg = 80 }: {
  errors?: Record<string, string>; unitSystem?: 'si' | 'conventional'; onboarding?: typeof DONE | typeof WEIGHT_BOX;
  previousMeasurements?: unknown[]; weightKg?: number | null;
} = {}) {
  const inputs = onboarding === DONE ? { sex: 'male' as const, heightCm: 180, birthYear: 1960, birthMonth: 1, weightKg: weightKg ?? undefined, psa: 2 } : { heightCm: 180, weightKg: weightKg ?? undefined };
  const props = {
    ...myHealth({ settingsOpen: onboarding === DONE }),
    inputs, effectiveInputs: inputs, onChange: vi.fn(), errors, unitSystem,
    unitOverrides: {}, onToggleFieldUnit: vi.fn(), previousMeasurements, bloodTestHistory: [], vitalsHistory: [],
    labValues: [], onSaveBloodTestBatch: vi.fn(async () => new Map()), medications: [],
    onMedicationChange: vi.fn(), onScreeningChange: vi.fn(), supplements: [], onSupplementChange: vi.fn(),
    screenings: [
      { id: 's1', screeningKey: 'prostate_discussion', value: 'will_screen', updatedAt: '' },
      { id: 's2', screeningKey: 'lung_smoking_history', value: 'former_smoker', updatedAt: '' },
      { id: 's3', screeningKey: 'lung_pack_years', value: '25', updatedAt: '' },
    ],
    onSupplementDelete: vi.fn(), scheduleLongitudinalSave: vi.fn(), flushLongitudinalSave: vi.fn(), isSavingLongitudinal: false,
    hasApiResponse: true, onboarding, planBasis: { age: 66 }, grading: {},
  };
  const view = render(<InputPanel {...(props as unknown as Parameters<typeof InputPanel>[0])} />);
  if (onboarding === DONE) openAboutYou(view.container);
  return (id: string) => view.container.querySelector<HTMLInputElement>(`#${id}`)!;
}

/** The text a screen reader reads as the box's description: its aria-describedby targets, in order. */
const description = (el: Element) => (el.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean)
  .map(id => document.getElementById(id)?.textContent ?? `(missing #${id})`).join(' | ');
const invalid = (el: Element) => el.getAttribute('aria-invalid');

/** What a browser hands the handler for "175,500" in a type="number" box (US-02 AC7). */
const typeUnreadable = (input: HTMLInputElement) => {
  Object.defineProperty(input, 'validity', { configurable: true, value: { ...input.validity, badInput: true } });
  fireEvent.change(input, { target: { value: '' } });
};
const typeEmpty = (input: HTMLInputElement) => {
  Object.defineProperty(input, 'validity', { configurable: true, value: { ...input.validity, badInput: false } });
  fireEvent.change(input, { target: { value: '' } });
};

it('US-02 AC5a: with no error shown, no box is invalid or described', () => {
  const box = renderPanel();
  for (const id of ['heightCm', 'birthMonth', 'birthYear', 'psa-input', 'lung-pack-years']) {
    expect([id, invalid(box(id)), description(box(id))]).toEqual([id, null, '']);
  }
});

it('US-02 AC5a: a height out of range is the cm box\'s description, and "Enter a number" when it cannot be read', () => {
  const box = renderPanel({ errors: { heightCm: 'Height must be at least 50 cm' } });
  expect([invalid(box('heightCm')), description(box('heightCm'))]).toEqual(['true', 'Height must be at least 50 cm']);
  cleanup();
  const unread = renderPanel();
  typeUnreadable(unread('heightCm'));
  expect([invalid(unread('heightCm')), description(unread('heightCm'))]).toEqual(['true', 'Enter a number']);
});

it('US-02 AC5a: in feet and inches the height error describes both boxes', () => {
  const box = renderPanel({ errors: { heightCm: 'Height must be at most 250 cm' }, unitSystem: 'conventional' });
  for (const id of ['heightFeet', 'heightInches']) {
    expect([id, invalid(box(id)), description(box(id))]).toEqual([id, 'true', 'Height must be at most 250 cm']);
  }
});

it('US-02 AC5a: the birth month and the birth year each carry their own error', () => {
  const box = renderPanel({ errors: { birthMonth: 'January 2090 is in the future, so it was not saved.', birthYear: 'Birth year must be after 1900' } });
  expect([invalid(box('birthMonth')), description(box('birthMonth'))]).toEqual(['true', 'January 2090 is in the future, so it was not saved.']);
  expect([invalid(box('birthYear')), description(box('birthYear'))]).toEqual(['true', 'Birth year must be after 1900']);
  cleanup();
  const yearOnly = renderPanel({ errors: { birthYear: 'Birth year must be after 1900' } });
  expect([invalid(yearOnly('birthMonth')), description(yearOnly('birthMonth'))]).toEqual([null, '']);
  expect(description(yearOnly('birthYear'))).toBe('Birth year must be after 1900');
});

it('US-02 AC5a: the onboarding\'s weight box carries its error; a cleared saved weight keeps only its note', () => {
  const box = renderPanel({ errors: { weightKg: 'Weight must be at least 20 kg' }, onboarding: WEIGHT_BOX });
  expect([invalid(box('weightKg')), description(box('weightKg'))]).toEqual(['true', 'Weight must be at least 20 kg']);
  cleanup();
  const unread = renderPanel({ onboarding: WEIGHT_BOX });
  typeUnreadable(unread('weightKg'));
  expect([invalid(unread('weightKg')), description(unread('weightKg'))]).toEqual(['true', 'Enter a number']);
  cleanup();
  const cleared = renderPanel({ onboarding: WEIGHT_BOX, previousMeasurements: SAVED_WEIGHT, weightKg: null }); // the box shows the saved 80
  typeEmpty(cleared('weightKg'));
  expect(invalid(cleared('weightKg'))).toBeNull();
  expect(cleared('weightKg').getAttribute('aria-describedby')).toBe('weight-still-counts');
  expect(description(cleared('weightKg'))).toMatch(/^Your plan still uses 80 kg from /);
});

it('US-02 AC5a: the PSA box and the pack-years box carry their errors', () => {
  const box = renderPanel({ errors: { psa: 'PSA must be at most 10,000 ng/mL' } });
  expect([invalid(box('psa-input')), description(box('psa-input'))]).toEqual(['true', 'PSA must be at most 10,000 ng/mL']);
  typeUnreadable(box('lung-pack-years'));
  expect([invalid(box('lung-pack-years')), description(box('lung-pack-years'))]).toEqual(['true', 'Enter a number']);
  cleanup();
  const unread = renderPanel();
  typeUnreadable(unread('psa-input'));
  expect([invalid(unread('psa-input')), description(unread('psa-input'))]).toEqual(['true', 'Enter a number']);
});
