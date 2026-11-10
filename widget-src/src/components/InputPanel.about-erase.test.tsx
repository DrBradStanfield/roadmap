// @vitest-environment jsdom
/**
 * US-62 AC12: an erase starts About you again. A row opened before the erase
 * does not come back open when the next record's About you goes low: every
 * row starts closed, as on a first visit.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { InputPanel } from './InputPanel';
import { myHealth } from '../testing/my-health-props';

vi.mock('../lib/server-api', async importOriginal => ({ ...await importOriginal<typeof import('../lib/server-api')>(), trackProductEvent: vi.fn() }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

afterEach(cleanup);
vi.stubGlobal('matchMedia', (q: string) => ({ matches: !q.includes('max-width'), media: q, addEventListener() {}, removeEventListener() {} }));

const inputs = { sex: 'male' as const, heightCm: 180, birthYear: 1960, birthMonth: 1 };
const props = (aboutYouLow: boolean) => ({
  ...myHealth({ settingsOpen: true }), // About you, low, sits in Settings (US-62 AC24)
  inputs, effectiveInputs: inputs, onChange: vi.fn(), errors: {}, unitSystem: 'si' as const,
  unitOverrides: {}, onToggleFieldUnit: vi.fn(), previousMeasurements: [], bloodTestHistory: [], vitalsHistory: [],
  labValues: [], onSaveBloodTestBatch: vi.fn(async () => new Map()), onDraftValue: vi.fn(), medications: [],
  onMedicationChange: vi.fn(), onScreeningChange: vi.fn(), supplements: [], onSupplementChange: vi.fn(), screenings: [],
  onSupplementDelete: vi.fn(), scheduleLongitudinalSave: vi.fn(), flushLongitudinalSave: vi.fn(), isSavingLongitudinal: false,
  fieldsSaved: 0, hasApiResponse: true, onboarding: { stage: 4 as const, reached: 4 as const, fullForm: true, aboutYouLow }, planBasis: { age: 66 }, grading: {},
}) as unknown as Parameters<typeof InputPanel>[0];

it('US-62 AC12: a row opened before an erase is closed when About you next goes low', () => {
  const view = render(<InputPanel {...props(true)} />);
  fireEvent.click(view.container.querySelector('#about-height')!);
  expect(view.container.querySelector('[data-about="height"] #heightCm')).not.toBeNull();

  view.rerender(<InputPanel {...props(false)} />); // the erase: About you back at the top
  expect(view.container.querySelector('#about-height')).toBeNull();

  view.rerender(<InputPanel {...props(true)} />); // the next record's answers are in
  expect(view.container.querySelector('#about-height .about-row-value')?.textContent).toBeTruthy();
  expect(view.container.querySelector('[data-about="height"]')).toBeNull();
});
