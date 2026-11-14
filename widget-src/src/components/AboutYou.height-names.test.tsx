// @vitest-environment jsdom
/** US-02 AC11a: in feet and inches the two height boxes each have a name a screen reader reads, in the onboarding's
 *  first question and in About you's Height row. The cm box keeps its label. Synthetic values. */
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { InputPanel } from './InputPanel';
import { myHealth } from '../testing/my-health-props';
import type { HealthInputs } from '@roadmap/health-core/types';

vi.mock('../lib/server-api', async importOriginal => ({ ...await importOriginal<typeof import('../lib/server-api')>(), trackProductEvent: vi.fn() }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.stubGlobal('matchMedia', (q: string) => ({ matches: !q.includes('max-width'), media: q, addEventListener() {}, removeEventListener() {} }));
afterEach(cleanup);

/** The panel holding its own inputs, as HealthTool does: stage 1 is the onboarding, 4 About you's rows in Settings. */
function Panel({ start, stage, unitSystem }: { start: Partial<HealthInputs>; stage: 1 | 4; unitSystem: 'si' | 'conventional' }) {
  const [inputs, setInputs] = useState(start);
  const props = {
    ...myHealth({ settingsOpen: stage === 4 }),
    inputs, effectiveInputs: inputs, onChange: (f: keyof HealthInputs, v: unknown) => setInputs(p => ({ ...p, [f]: v })),
    errors: {}, unitSystem, unitOverrides: {}, onToggleFieldUnit: vi.fn(), previousMeasurements: [],
    bloodTestHistory: [], vitalsHistory: [], labValues: [], onSaveBloodTestBatch: vi.fn(async () => new Map()),
    medications: [], onMedicationChange: vi.fn(), onScreeningChange: vi.fn(), supplements: [], onSupplementChange: vi.fn(), screenings: [],
    onSupplementDelete: vi.fn(), scheduleLongitudinalSave: vi.fn(), flushLongitudinalSave: vi.fn(), isSavingLongitudinal: false,
    hasApiResponse: true, planBasis: { age: 66 }, grading: {},
    onboarding: { stage, reached: stage, fullForm: stage === 4, aboutYouLow: stage === 4 },
  } as unknown as Parameters<typeof InputPanel>[0];
  return <InputPanel {...props}/>;
}

const feetAndInches = () => [screen.getByRole('textbox', { name: 'Height, feet' }), screen.getByRole('textbox', { name: 'Height, inches' })];

it('US-02 AC11a: the onboarding\'s first question in US units names its boxes "Height, feet" and "Height, inches"', () => {
  render(<Panel start={{}} stage={1} unitSystem="conventional"/>);
  expect(feetAndInches().map(box => box.id)).toEqual(['heightFeet', 'heightInches']);
});

it('US-02 AC11a: About you\'s Height row in US units, opened with a height saved, names both boxes the same way', () => {
  const { container } = render(<Panel start={{ sex: 'male', heightCm: 180, birthYear: 1960, birthMonth: 1 }} stage={4} unitSystem="conventional"/>);
  fireEvent.click(container.querySelector('#about-height')!);
  expect(feetAndInches().map(box => (box as HTMLInputElement).value)).toEqual(['5', '11']);
});

it('US-02 AC11a: in cm the one box keeps its "Height" label and gets no feet or inches name', () => {
  render(<Panel start={{}} stage={1} unitSystem="si"/>);
  expect(screen.getByRole('spinbutton', { name: /^Height/ }).id).toBe('heightCm');
  expect(screen.queryByRole('textbox', { name: /feet|inches/ })).toBeNull();
});
